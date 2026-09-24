# 网页
"""把网页发给手机和电脑，并把取号请求转给商家。不保存账号、密码和 token，不替人轮询。"""

import base64
import json
import re
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


监听地址 = "0.0.0.0"
监听端口 = 8765
商家根 = "https://www.xrkapp.cc/v1/api"
允许接口 = ("balance", "get_mobile", "get_verifycode", "feedback")
转发方式 = "排队"  # 改成 "不排队" 就直接转发
每秒放行 = 9
公钥原文 = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3yLX36pjyTaPBcqAk1qS
++MxPI8/FNHALIeG4DPv8MYeUk0L7TuvtgF6AypcqP1yqVBAVvgPJWofWjMuthSx
zmqPZxqrd2YTIejxnBEJ+hv2ZOSkWuKIGzWL/hz1pQ8HIyJ6iicBm8Ttcb/VXRJF
4sLgn10kkuRcUYnZ+6KCrMhixgHiezzvkW/nsGJxmxMJpjPqXqZdxkxhLqb3BbMe
sq60NPwXX59rislbxgoJU4wkVaI8ynYIi0z5oTgH0OXtCghepv+vR+4mOthI/vuo
JYvC3DPJNwVn/F2hQFPsxEMve84+Eh4rA8+WfNVJx0JnaX2UN0i4AMjj9BFn1dZL
YQIDAQAB
-----END PUBLIC KEY-----"""
网页目录 = Path(__file__).resolve().parent / "网页"
页面文件 = {
    "/": "index.html",
    "/index.html": "index.html",
    "/样式.css": "样式.css",
    "/脚本.js": "脚本.js",
}
内容类型 = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}
日志行 = []


def 写日志(参_文本):
    日志行.append(参_文本)
    if len(日志行) > 300:
        del 日志行[:-300]
    print(参_文本, flush=True)


def _空队():
    return {"锁": threading.Lock(), "排队": deque(), "发出时间": []}


队伍 = {
    "get_mobile": _空队(),
    "get_verifycode": _空队(),
    "balance": _空队(),
    "feedback": _空队(),
    "login": _空队(),
}


def 清空排队():
    """清掉还在排的人和这一秒已经放行的记录。"""

    for 队 in 队伍.values():
        with 队["锁"]:
            队["排队"].clear()
            del 队["发出时间"][:]


def 排队放行(参_接口):
    """同一接口按先来后到，每秒最多放行 9 次。"""

    队 = 队伍[参_接口]
    事件 = threading.Event()
    with 队["锁"]:
        队["排队"].append(事件)
        我是队首 = len(队["排队"]) == 1
    if 我是队首:
        事件.set()
    try:
        事件.wait()
        while True:
            with 队["锁"]:
                现在 = time.monotonic()
                队["发出时间"][:] = [点 for 点 in 队["发出时间"] if 现在 - 点 < 1]
                if len(队["发出时间"]) < 每秒放行:
                    队["发出时间"].append(现在)
                    队["排队"].popleft()
                    if 队["排队"]:
                        队["排队"][0].set()
                    return
                再等 = 1 - (现在 - 队["发出时间"][0])
            time.sleep(max(再等, 0.01))
    except BaseException:
        with 队["锁"]:
            if 队["排队"] and 队["排队"][0] is 事件:
                队["排队"].popleft()
                if 队["排队"]:
                    队["排队"][0].set()
            else:
                try:
                    队["排队"].remove(事件)
                except ValueError:
                    pass
        raise


def 直接放行(参_接口):
    """不排队，马上转发。"""

    return


def 放行(参_接口):
    """按转发方式选择排队或不排队。"""

    if 转发方式 == "排队":
        排队放行(参_接口)
    elif 转发方式 == "不排队":
        直接放行(参_接口)


def _读长度(参_数据, 参_位置):
    首 = 参_数据[参_位置]
    参_位置 += 1
    if 首 < 0x80:
        return 首, 参_位置
    字节数 = 首 & 0x7F
    长度 = int.from_bytes(参_数据[参_位置:参_位置 + 字节数], "big")
    return 长度, 参_位置 + 字节数


def _读块(参_数据, 参_位置):
    长度, 参_位置 = _读长度(参_数据, 参_位置 + 1)
    结束 = 参_位置 + 长度
    return 参_数据[参_位置:结束], 结束


def 取公钥():
    """从商家网页那把公钥里取出模数和指数。"""

    行 = [行.strip() for 行 in 公钥原文.splitlines() if "-----" not in 行]
    原始 = base64.b64decode("".join(行))
    外层, _ = _读块(原始, 0)
    _, 位置 = _读块(外层, 0)
    位串, _ = _读块(外层, 位置)
    数, _ = _读块(位串, 1)
    模字节, 位置 = _读块(数, 0)
    指字节, _ = _读块(数, 位置)
    return int.from_bytes(模字节, "big"), int.from_bytes(指字节, "big")


def 加密密码(参_密码):
    """按商家网页的方式做 PKCS#1 v1.5，返回 base64。"""

    模数, 指数 = 取公钥()
    密钥长 = (模数.bit_length() + 7) // 8
    明文 = 参_密码.encode("utf-8")
    if len(明文) > 密钥长 - 11:
        raise ValueError("密码太长")
    填充 = bytearray()
    while len(填充) < 密钥长 - len(明文) - 3:
        字节 = secrets.token_bytes(1)
        if 字节 != b"\x00":
            填充 += 字节
    块 = b"\x00\x02" + bytes(填充) + b"\x00" + 明文
    密文 = pow(int.from_bytes(块, "big"), 指数, 模数)
    return base64.b64encode(密文.to_bytes(密钥长, "big")).decode("ascii")


def 登录地址():
    根 = 商家根.rstrip("/")
    if 根.endswith("/api"):
        根 = 根[: -len("/api")]
    return 根 + "/login/worker_login"


def 登录(参_原文):
    """账号密码换 token。日志不写账号、密码和 token。"""

    try:
        数据 = json.loads(参_原文.decode("utf-8"))
    except Exception:
        return 400, "请求不对".encode("utf-8"), "text/plain; charset=utf-8"
    if not isinstance(数据, dict):
        return 400, "请求不对".encode("utf-8"), "text/plain; charset=utf-8"
    账号 = str(数据.get("账号") or "").strip()
    密码 = str(数据.get("密码") or "")
    if not 账号 or not 密码:
        return 400, "请输入账号和密码".encode("utf-8"), "text/plain; charset=utf-8"
    try:
        密文 = 加密密码(密码)
    except Exception:
        写日志("转发 login 失败")
        return 502, "请求失败".encode("utf-8"), "text/plain; charset=utf-8"
    正文 = json.dumps({"username": 账号, "password": 密文}, ensure_ascii=False).encode("utf-8")
    放行("login")
    写日志("转发 login")
    请求 = urllib.request.Request(
        登录地址(),
        data=正文,
        method="POST",
        headers={"Content-Type": "application/json", "From-client": "h5"},
    )
    try:
        with urllib.request.urlopen(请求, timeout=15) as 响应:
            返回 = 响应.read()
            类型 = 响应.headers.get("Content-Type") or "application/json; charset=utf-8"
            return 响应.status, 返回, 类型
    except urllib.error.HTTPError as 错误:
        类型 = 错误.headers.get("Content-Type") if 错误.headers else None
        return 错误.code, 错误.read(), 类型 or "text/plain; charset=utf-8"
    except Exception:
        写日志("转发 login 失败")
        return 502, "请求失败".encode("utf-8"), "text/plain; charset=utf-8"


def 转发(参_接口, 参_查询):
    """把浏览器的一次 GET 转给商家。查询串原样带上，日志里不写 token。"""

    if 参_接口 not in 允许接口:
        return 404, "不允许的接口".encode("utf-8"), "text/plain; charset=utf-8"
    地址 = 商家根.rstrip("/") + "/" + 参_接口
    if 参_查询:
        地址 += "?" + 参_查询
    放行(参_接口)
    写日志(f"转发 {参_接口}")
    请求 = urllib.request.Request(地址, method="GET")
    try:
        with urllib.request.urlopen(请求, timeout=15) as 响应:
            正文 = 响应.read()
            类型 = 响应.headers.get("Content-Type") or "text/plain; charset=utf-8"
            return 响应.status, 正文, 类型
    except urllib.error.HTTPError as 错误:
        类型 = 错误.headers.get("Content-Type") if 错误.headers else None
        return 错误.code, 错误.read(), 类型 or "text/plain; charset=utf-8"
    except Exception:
        写日志(f"转发 {参_接口} 失败")
        return 502, "请求失败".encode("utf-8"), "text/plain; charset=utf-8"


class 处理器(BaseHTTPRequestHandler):
    def log_message(self, 格式, *参数):
        """默认日志会带上网址，里面有 token，这里不记。"""

        return

    def do_GET(self):
        拆 = urllib.parse.urlsplit(self.path)
        路径 = urllib.parse.unquote(拆.path)
        if 路径.startswith("/api/"):
            状态, 正文, 类型 = 转发(路径[len("/api/"):], 拆.query)
            self._送出(状态, 正文, 类型)
            return
        文件名 = 页面文件.get(路径)
        if not 文件名:
            self._送出(404, "没有这个页面".encode("utf-8"), "text/plain; charset=utf-8")
            return
        文件 = 网页目录 / 文件名
        if not 文件.is_file():
            self._送出(404, "页面文件缺失".encode("utf-8"), "text/plain; charset=utf-8")
            return
        类型 = 内容类型.get(文件.suffix, "application/octet-stream")
        self._送出(200, 文件.read_bytes(), 类型)

    def do_POST(self):
        拆 = urllib.parse.urlsplit(self.path)
        路径 = urllib.parse.unquote(拆.path)
        if 路径 != "/api/login":
            self._送出(404, "不允许的接口".encode("utf-8"), "text/plain; charset=utf-8")
            return
        try:
            长度 = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            长度 = 0
        if 长度 < 0 or 长度 > 4096:
            self._送出(400, "请求不对".encode("utf-8"), "text/plain; charset=utf-8")
            return
        状态, 正文, 类型 = 登录(self.rfile.read(长度))
        self._送出(状态, 正文, 类型)

    def _送出(self, 参_状态, 参_正文, 参_类型):
        self.send_response(参_状态)
        self.send_header("Content-Type", 参_类型)
        self.send_header("Content-Length", str(len(参_正文)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(参_正文)


def 做服务(参_主机=监听地址, 参_端口=监听端口):
    """Windows 上开着端口复用时，两个进程能同时占住同一个端口，所以关掉，被占用就直接报错。"""

    服务 = ThreadingHTTPServer((参_主机, 参_端口), 处理器, bind_and_activate=False)
    服务.allow_reuse_address = False
    try:
        服务.server_bind()
        服务.server_activate()
    except OSError:
        服务.server_close()
        raise
    return 服务


def 取本机IP():
    """列出本机 IPv4。开着代理 TUN 时 socket 只能拿到虚拟网卡的地址，所以读 ipconfig。"""

    try:
        输出 = subprocess.run(
            ["ipconfig"],
            capture_output=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout.decode("oem", "ignore")
    except Exception:
        return []
    地址们 = []
    for 行 in 输出.splitlines():
        找到 = re.search(r"IPv4.*?(\d+\.\d+\.\d+\.\d+)", 行)
        if 找到 and not 找到.group(1).startswith(("127.", "169.254.")):
            地址们.append(找到.group(1))
    return 地址们


def 启动():
    try:
        服务 = 做服务()
    except OSError as 错误:
        写日志(f"端口 {监听端口} 打不开（可能已经开着一个接码网页）：{错误}")
        return
    写日志(f"接码网页已打开 http://127.0.0.1:{监听端口}")
    地址们 = 取本机IP()
    if 地址们:
        写日志("手机选同一网络的地址打开：" + "  ".join(f"http://{地址}:{监听端口}" for 地址 in 地址们))
    服务.serve_forever()


if __name__ == "__main__":
    启动()
