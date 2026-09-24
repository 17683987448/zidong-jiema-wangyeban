# 转发测试
"""假商家。确认取号、收码、余额和反馈能转回去，别的路径拒绝，日志里不出现 token。"""

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import 网页


class 假商家(BaseHTTPRequestHandler):
    记录 = []

    def do_POST(self):
        长度 = int(self.headers.get("Content-Length") or "0")
        正文 = self.rfile.read(长度)
        假商家.记录.append("POST " + self.path + " " + 正文.decode("utf-8"))
        名字 = self.path.split("?", 1)[0].rstrip("/").split("/")[-1]
        if 名字 != "worker_login":
            self.send_response(500)
            self.end_headers()
            return
        返回 = json.dumps(
            {"code": 200, "data": {"token": "issued-token"}, "msg": "ok"},
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(返回)))
        self.end_headers()
        self.wfile.write(返回)

    def do_GET(self):
        假商家.记录.append(self.path)
        名字 = self.path.split("?", 1)[0].rstrip("/").split("/")[-1]
        if 名字 == "balance":
            正文, 类型 = b"4520", "text/plain; charset=utf-8"
        elif 名字 == "get_mobile":
            正文 = json.dumps(
                {"code": 200, "data": {"mobile": "13900000001", "mid": 8, "address": "甲"}, "msg": "ok"},
                ensure_ascii=False,
            ).encode("utf-8")
            类型 = "application/json; charset=utf-8"
        elif 名字 == "get_verifycode":
            正文 = json.dumps(
                {"code": 200, "data": "验证码 123456", "msg": "ok"},
                ensure_ascii=False,
            ).encode("utf-8")
            类型 = "application/json; charset=utf-8"
        elif 名字 == "feedback":
            正文 = json.dumps(
                {"code": 200, "msg": "ok"},
                ensure_ascii=False,
            ).encode("utf-8")
            类型 = "application/json; charset=utf-8"
        else:
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", 类型)
        self.send_header("Content-Length", str(len(正文)))
        self.end_headers()
        self.wfile.write(正文)

    def log_message(self, 格式, *参数):
        return


class 转发测试(unittest.TestCase):
    def setUp(self):
        假商家.记录 = []
        self.假服务 = ThreadingHTTPServer(("127.0.0.1", 0), 假商家)
        self.假线程 = threading.Thread(target=self.假服务.serve_forever, daemon=True)
        self.假线程.start()
        self.原根 = 网页.商家根
        网页.商家根 = f"http://127.0.0.1:{self.假服务.server_address[1]}/v1/api"
        网页.日志行.clear()
        self.服务 = 网页.做服务("127.0.0.1", 0)
        self.线程 = threading.Thread(target=self.服务.serve_forever, daemon=True)
        self.线程.start()
        self.本机 = f"http://127.0.0.1:{self.服务.server_address[1]}"

    def tearDown(self):
        self.服务.shutdown()
        self.服务.server_close()
        self.假服务.shutdown()
        self.假服务.server_close()
        网页.商家根 = self.原根

    def _取(self, 参_路径):
        with urllib.request.urlopen(self.本机 + 参_路径, timeout=5) as 响应:
            return 响应.status, 响应.read()

    def _送(self, 参_路径, 参_正文):
        请求 = urllib.request.Request(
            self.本机 + 参_路径,
            data=参_正文,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(请求, timeout=5) as 响应:
            return 响应.status, 响应.read()

    def test_三个接口能转回去且日志没有token(self):
        状态, 正文 = self._取("/api/balance?token=secret-token")
        self.assertEqual(状态, 200)
        self.assertEqual(正文, b"4520")

        状态, 正文 = self._取("/api/get_mobile?token=secret-token")
        self.assertEqual(状态, 200)
        self.assertIn("13900000001".encode(), 正文)

        状态, 正文 = self._取("/api/get_verifycode?token=secret-token&mid=8")
        self.assertEqual(状态, 200)
        self.assertIn("123456".encode(), 正文)

        拼起来 = "\n".join(网页.日志行)
        self.assertNotIn("secret-token", 拼起来)
        self.assertIn("转发 balance", 网页.日志行)
        self.assertIn("转发 get_mobile", 网页.日志行)
        self.assertIn("转发 get_verifycode", 网页.日志行)
        self.assertTrue(any("balance?token=secret-token" in 条 for 条 in 假商家.记录))
        self.assertTrue(any("mid=8" in 条 for 条 in 假商家.记录))

    def test_反馈能转回去且日志没有token(self):
        状态, 正文 = self._取("/api/feedback?token=secret-token&mid=8&status=20")
        self.assertEqual(状态, 200)
        self.assertIn(b'"code": 200', 正文)
        拼起来 = "\n".join(网页.日志行)
        self.assertNotIn("secret-token", 拼起来)
        self.assertIn("转发 feedback", 网页.日志行)
        self.assertTrue(any("mid=8" in 条 and "status=20" in 条 for 条 in 假商家.记录))

    def test_刷新token和乱路径不转发(self):
        之前 = len(假商家.记录)
        for 路径 in ("/api/refresh_token?token=secret-token", "/api/other"):
            with self.assertRaises(urllib.error.HTTPError) as 抓住:
                self._取(路径)
            self.assertEqual(抓住.exception.code, 404)
            self.assertNotIn("secret-token", 抓住.exception.read().decode("utf-8"))
        self.assertEqual(len(假商家.记录), 之前)
        self.assertNotIn("secret-token", "\n".join(网页.日志行))

    def test_商家连不上时日志没有token(self):
        网页.商家根 = "http://127.0.0.1:9/v1/api"
        状态, 正文, _类型 = 网页.转发("balance", "token=secret-token")
        self.assertEqual(状态, 502)
        self.assertNotIn("secret-token", 正文.decode("utf-8"))
        self.assertNotIn("secret-token", "\n".join(网页.日志行))
        self.assertIn("转发 balance 失败", 网页.日志行)

    def test_登录会加密密码且日志没有密码和token(self):
        import base64

        明文 = "plain-password"
        状态, 正文 = self._送(
            "/api/login",
            json.dumps({"账号": "zhang", "密码": 明文}, ensure_ascii=False).encode("utf-8"),
        )
        self.assertEqual(状态, 200)
        数据 = json.loads(正文.decode("utf-8"))
        self.assertEqual(数据["data"]["token"], "issued-token")
        self.assertTrue(假商家.记录)
        转发体 = 假商家.记录[-1]
        self.assertIn("/v1/login/worker_login", 转发体)
        self.assertNotIn(明文, 转发体)
        密文 = json.loads(转发体.split(" ", 2)[2])["password"]
        原始 = base64.b64decode(密文)
        self.assertEqual(len(原始), 256)
        拼起来 = "\n".join(网页.日志行)
        self.assertIn("转发 login", 网页.日志行)
        self.assertNotIn(明文, 拼起来)
        self.assertNotIn("issued-token", 拼起来)
        self.assertNotIn("zhang", 拼起来)

    def test_首页能打开(self):
        状态, 正文 = self._取("/")
        self.assertEqual(状态, 200)
        self.assertIn("接码取号工作台".encode("utf-8"), 正文)


if __name__ == "__main__":
    unittest.main()
