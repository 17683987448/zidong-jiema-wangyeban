// 接码网页
// 取号、收码、限流和号码都在这台浏览器里。服务器只转发那一次请求。

const 收码间隔秒 = 3;
const 每秒上限 = 9;
const 余额刷新秒 = 5;
const 收码并发 = 4;
const 默认配置 = { 账号: "", token: "", 目标: 10, 间隔: 1, 线程数: 1, 短信轮询: 5, 演示模式: false };

const 库 = {
  列表: [],
  目标: 10,
  间隔: 1,
  演示模式: false,
  token: "",
  本批已取: 0,
  在途: 0,
  运行中: false,
  待收码: {},
  已超时: {},
};

let 已连接 = false;
let 连接代号 = 0;
let 正在查余额 = false;
let 上次查余额 = 0;
let 当前记录 = null;
let 锁定当前 = false;
let 筛选 = "全部";
let 日志行 = [];
let 取号停止 = false;
let 取号进行中 = 0;
let 正在停止 = false;
let 已启动 = false;
let 失败原因 = "";
let 闸门时间点 = [];
let 演示序号 = 0;
let 查询次数 = {};
let 上次查询 = {};
let 收码中 = {};
let 收码停止 = false;
let 表格签名 = "";
let 临时状态到 = 0;
let 临时状态文字 = "";
let 临时状态色 = "";
let 状态原文 = "";
let 状态原色 = "";
const $ = (id) => document.getElementById(id);

function 现在秒() {
  return performance.now() / 1000;
}

function 睡(秒) {
  return new Promise((完成) => setTimeout(完成, Math.max(0, 秒) * 1000));
}

function 读配置() {
  const 结果 = { ...默认配置 };
  try {
    const 数据 = JSON.parse(localStorage.getItem("界面配置") || "");
    if (typeof 数据.账号 === "string") 结果.账号 = 数据.账号;
    if (typeof 数据.token === "string") 结果.token = 数据.token;
    for (const 键 of ["目标", "间隔", "线程数", "短信轮询"]) {
      const 数 = parseInt(数据[键], 10);
      if (!Number.isNaN(数)) 结果[键] = 数;
    }
    if (typeof 数据.演示模式 === "boolean") 结果.演示模式 = 数据.演示模式;
  } catch (错误) {
    /* 没有存过配置 */
  }
  结果.线程数 = Math.min(16, Math.max(1, 结果.线程数));
  结果.间隔 = Math.max(1, 结果.间隔);
  结果.目标 = Math.max(1, 结果.目标);
  结果.短信轮询 = Math.min(60, Math.max(1, 结果.短信轮询));
  return 结果;
}

function 保存配置() {
  const 配置 = {
    账号: $("账号框").value,
    token: 库.token,
    目标: 数字框("目标框"),
    间隔: 数字框("间隔框"),
    线程数: 数字框("线程框"),
    短信轮询: 数字框("轮询框"),
    演示模式: $("演示框").checked,
  };
  localStorage.setItem("界面配置", JSON.stringify(配置));
}

function 读号码() {
  try {
    const 数据 = JSON.parse(localStorage.getItem("号码记录") || "[]");
    if (!Array.isArray(数据)) return;
    库.列表 = 数据.filter((号) => 号 && 号.手机号码).map((号) => ({
      手机号码: String(号.手机号码),
      任务编号: String(号.任务编号 || ""),
      归属地: String(号.归属地 || ""),
      获取时间: String(号.获取时间 || ""),
      状态: String(号.状态 || "待使用"),
      验证码: String(号.验证码 || ""),
      短信内容: String(号.短信内容 || ""),
      演示: 号.演示 === true || 号.归属地 === "演示归属地",
      收码起点: Number(号.收码起点) || 0,
    }));
    for (const 号 of 库.列表) {
      if (号.演示) 演示序号 = Math.max(演示序号, Number(号.任务编号) - 800000000 || 0);
    }
  } catch (错误) {
    库.列表 = [];
  }
}

function 保存号码() {
  localStorage.setItem("号码记录", JSON.stringify(库.列表));
}

function 数字框(id) {
  return parseInt($(id).value, 10) || 1;
}

function 超时秒() {
  return 数字框("轮询框") * 60;
}

function _阶段() {
  if (!库.运行中) return "停止";
  if (库.本批已取 + 库.在途 >= 库.目标) return "已满";
  return "可以";
}

function 占一个名额() {
  const 阶段 = _阶段();
  if (阶段 !== "可以") return 阶段;
  库.在途 += 1;
  return "可以";
}

function 退回在途() {
  if (库.在途 > 0) 库.在途 -= 1;
}

function 更新参数() {
  库.目标 = 数字框("目标框");
  库.间隔 = 数字框("间隔框");
}

function 开始新批次() {
  更新参数();
  库.演示模式 = $("演示框").checked;
  库.本批已取 = 0;
  库.在途 = 0;
  库.运行中 = true;
}

function 继续取号() {
  更新参数();
  库.演示模式 = $("演示框").checked;
  if (库.本批已取 >= 库.目标) return false;
  库.运行中 = true;
  return true;
}

function 请求停止() {
  库.运行中 = false;
}

function 记下(号码, 编号, 归属, 演示) {
  退回在途();
  库.本批已取 += 1;
  const 记录 = {
    手机号码: 号码,
    任务编号: String(编号),
    归属地: 归属,
    获取时间: 取时间文本(),
    状态: "待使用",
    验证码: "",
    短信内容: "",
    演示,
    收码起点: Date.now(),
  };
  库.列表.push(记录);
  库.待收码[记录.任务编号] = 现在秒();
  保存号码();
  return { ...记录 };
}

function 标记已用(编号) {
  const 目标 = String(编号);
  const 号 = 库.列表.find((条) => 条.任务编号 === 目标 && (条.状态 === "待使用" || 条.状态 === "已收码"));
  if (!号) return null;
  号.状态 = "已使用";
  保存号码();
  return { ...号 };
}

function 标记状态(编号, 状态) {
  if (!["成功", "错误", "老号"].includes(状态)) return null;
  const 目标 = String(编号);
  const 号 = 库.列表.find((条) => 条.任务编号 === 目标);
  if (!号) return null;
  号.状态 = 状态;
  delete 库.待收码[目标];
  delete 库.已超时[目标];
  保存号码();
  return { ...号 };
}

function 取待收码() {
  const 现在 = 现在秒();
  const 限 = 超时秒();
  const 待用 = {};
  for (const 号 of 库.列表) {
    if (号.状态 === "待使用") 待用[号.任务编号] = 号;
  }
  const 要查 = [];
  const 超时 = [];
  for (const 编号 of Object.keys(库.待收码)) {
    if (!待用[编号]) {
      delete 库.待收码[编号];
    } else if (现在 - 库.待收码[编号] >= 限) {
      delete 库.待收码[编号];
      库.已超时[编号] = true;
      超时.push({ ...待用[编号] });
    } else {
      要查.push(编号);
    }
  }
  return [要查, 超时];
}

function 重新收码(编号) {
  const 目标 = String(编号);
  const 号 = 库.列表.find((条) => 条.任务编号 === 目标 && 条.状态 === "待使用");
  if (!号) return false;
  库.待收码[目标] = 现在秒();
  号.收码起点 = Date.now();
  保存号码();
  delete 库.已超时[目标];
  delete 查询次数[目标];
  delete 上次查询[目标];
  return true;
}

function 恢复收码() {
  const 限 = 超时秒();
  for (const 号 of 库.列表) {
    if (号.状态 !== "待使用") continue;
    const 已过秒 = (Date.now() - 号.收码起点) / 1000;
    if (号.收码起点 && 已过秒 < 限) 库.待收码[号.任务编号] = 现在秒() - 已过秒;
    else 库.已超时[号.任务编号] = true;
  }
}

function 收码状态() {
  const 现在 = 现在秒();
  const 限 = 超时秒();
  const 结果 = {};
  for (const 号 of 库.列表) {
    if (号.状态 !== "待使用") continue;
    const 编号 = 号.任务编号;
    if (编号 in 库.待收码) {
      const 剩 = Math.max(0, Math.floor(限 - (现在 - 库.待收码[编号])));
      结果[编号] = `轮询中 剩 ${Math.floor(剩 / 60)}:${String(剩 % 60).padStart(2, "0")}`;
    } else if (库.已超时[编号]) {
      结果[编号] = "已停止(超时)";
    }
  }
  return 结果;
}

function 记下验证码(编号, 验证码, 短信) {
  const 目标 = String(编号);
  delete 库.待收码[目标];
  const 号 = 库.列表.find((条) => 条.任务编号 === 目标 && 条.状态 === "待使用");
  if (!号) return null;
  号.状态 = "已收码";
  号.验证码 = 验证码;
  号.短信内容 = 短信;
  保存号码();
  return { ...号 };
}

function 清空号码() {
  库.列表 = [];
  库.待收码 = {};
  库.已超时 = {};
  保存号码();
}

function 删除号码(编号) {
  const 目标 = String(编号);
  const 下标 = 库.列表.findIndex((条) => 条.任务编号 === 目标);
  if (下标 < 0) return null;
  const [号] = 库.列表.splice(下标, 1);
  delete 库.待收码[目标];
  delete 库.已超时[目标];
  delete 查询次数[目标];
  delete 上次查询[目标];
  保存号码();
  return { ...号 };
}

function 找号(编号) {
  const 号 = 库.列表.find((条) => 条.任务编号 === String(编号));
  return 号 ? { ...号 } : null;
}

function 统计() {
  return {
    本批已取: 库.本批已取,
    目标: 库.目标,
    待使用: 库.列表.filter((号) => 号.状态 === "待使用").length,
    已使用: 库.列表.filter((号) => 号.状态 === "已使用").length,
    已收码: 库.列表.filter((号) => 号.状态 === "已收码").length,
    运行中: 库.运行中,
  };
}

function 筛选号码() {
  const 关键字 = $("搜索框").value.trim();
  return 库.列表.filter((号) => {
    if (筛选 !== "全部" && 号.状态 !== 筛选) return false;
    if (!关键字) return true;
    return `${号.手机号码} ${号.任务编号} ${号.归属地}`.includes(关键字);
  });
}

function 取时间文本() {
  const 日 = new Date();
  const 两位 = (n) => String(n).padStart(2, "0");
  return `${两位(日.getHours())}:${两位(日.getMinutes())}:${两位(日.getSeconds())} ${两位(日.getMonth() + 1)}/${两位(日.getDate())}`;
}

function 文字转数字(文本) {
  const 干净 = String(文本).replace(/,/g, "").trim();
  if (!干净) return null;
  const 数 = Number(干净);
  if (!Number.isFinite(数)) return null;
  return 数;
}

function 解析正文(文本) {
  const 原文 = String(文本 || "").trim();
  if (!原文) return { code: 0, msg: "返回不是 JSON" };
  try {
    const 数据 = JSON.parse(原文);
    if (typeof 数据 === "boolean" || 数据 === null || Array.isArray(数据)) {
      return { code: 0, msg: "返回不是 JSON" };
    }
    if (typeof 数据 === "number") return { code: 200, data: 数据 };
    if (typeof 数据 === "string") {
      const 数字 = 文字转数字(数据);
      if (数字 !== null) return { code: 200, data: 数字 };
      return { code: 0, msg: 数据.slice(0, 80) };
    }
    return 数据;
  } catch (错误) {
    const 数字 = 文字转数字(原文);
    if (数字 !== null) return { code: 200, data: 数字 };
    return { code: 0, msg: 原文.slice(0, 80) || "返回不是 JSON" };
  }
}

function 是成功(数据) {
  return 数据 && String(数据.code) === "200";
}

function 解析手机号(数据) {
  if (!数据 || typeof 数据 !== "object") return [false, "", "", "", "返回不是 JSON"];
  if (!是成功(数据)) return [false, "", "", "", String(数据.msg || "取号失败")];
  const 内 = 数据.data || {};
  if (typeof 内 !== "object") return [false, "", "", "", String(数据.msg || "没有号码")];
  const 号码 = String(内.mobile || "").trim();
  const 编号 = String(内.mid || "").trim();
  const 归属 = String(内.address || "").trim();
  if (!号码) return [false, "", "", "", String(数据.msg || "没有号码")];
  return [true, 号码, 编号, 归属, String(数据.msg || "")];
}

function 解析验证码(数据) {
  if (!数据 || typeof 数据 !== "object") return [false, "", "", "返回不是 JSON"];
  const 消息 = String(数据.msg || "");
  if (!是成功(数据)) return [false, "", "", 消息 || "还没收到验证码"];
  const 内 = 数据.data;
  if (内 === null || 内 === undefined || 内 === "") return [false, "", "", 消息 || "还没收到验证码"];
  const 信息 = typeof 内 === "string" ? 内.trim() : JSON.stringify(内);
  const 找到 = 信息.match(/(?<!\d)\d{4,8}(?!\d)/);
  if (!找到) return [false, "", 信息, 消息 || "还没收到验证码"];
  return [true, 找到[0], 信息, 消息];
}

function 找余额数字(数据, 允许文字) {
  if (typeof 数据 === "boolean" || 数据 === null || 数据 === undefined) return null;
  if (typeof 数据 === "number") return 数据;
  if (typeof 数据 === "string") return 允许文字 ? 文字转数字(数据) : null;
  if (typeof 数据 !== "object") return null;
  for (const 键 of ["余额", "balance", "积分", "points", "money", "amount", "score"]) {
    if (键 in 数据) {
      const 数字 = 找余额数字(数据[键], true);
      if (数字 !== null) return 数字;
    }
  }
  for (const 值 of Object.values(数据)) {
    if (typeof 值 === "number") return 值;
    if (值 && typeof 值 === "object" && !Array.isArray(值)) {
      const 数字 = 找余额数字(值, false);
      if (数字 !== null) return 数字;
    }
  }
  return null;
}

function 格式化余额(数字) {
  if (!Number.isInteger(数字)) {
    return 数字.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return 数字.toLocaleString("en-US");
}

function 解析余额(数据) {
  if (!数据 || typeof 数据 !== "object") return [false, "", "返回不是 JSON"];
  if (!是成功(数据)) return [false, "", String(数据.msg || "查询余额失败")];
  let 内 = 数据.data;
  if (内 === undefined || 内 === null) {
    内 = {};
    for (const [键, 值] of Object.entries(数据)) {
      if (键 !== "code" && 键 !== "msg") 内[键] = 值;
    }
  }
  const 数字 = 找余额数字(内, typeof 内 === "string");
  if (数字 === null) return [false, "", "没找到余额数字"];
  return [true, 格式化余额(数字), ""];
}

async function 请求接口(路径, 参数) {
  const 查询 = new URLSearchParams(参数).toString();
  try {
    const 响应 = await fetch("/api/" + 路径 + "?" + 查询, { cache: "no-store" });
    const 文本 = await 响应.text();
    return 解析正文(文本);
  } catch (错误) {
    return { code: 0, msg: "请求失败: " + 错误 };
  }
}

async function 请求登录(账号, 密码) {
  try {
    const 响应 = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 账号, 密码 }),
    });
    const 文本 = await 响应.text();
    return 解析正文(文本);
  } catch (错误) {
    return { code: 0, msg: "请求失败: " + 错误 };
  }
}

function 造演示号码() {
  演示序号 += 1;
  const 号码 = "13" + String(演示序号).padStart(9, "0").slice(-9);
  return {
    code: 200,
    data: { address: "演示归属地", mid: 800000000 + 演示序号, mobile: 号码 },
    msg: "演示取号",
  };
}

function 造演示验证码(第几次) {
  if (第几次 < 2) return { code: 200, data: "", msg: "演示：还没收到" };
  return { code: 200, data: "【演示】您的验证码是 123456", msg: "演示收码" };
}

async function 等一个名额(已停止) {
  while (!已停止()) {
    const 现在 = 现在秒();
    闸门时间点 = 闸门时间点.filter((点) => 现在 - 点 < 1);
    if (闸门时间点.length < 每秒上限) {
      闸门时间点.push(现在);
      return true;
    }
    const 再等 = 1 - (现在 - 闸门时间点[0]);
    await 睡(Math.min(Math.max(再等, 0.01), 0.05));
  }
  return false;
}

async function 可中断等待(秒, 已停止) {
  const 截止 = 现在秒() + 秒;
  while (现在秒() < 截止) {
    if (已停止()) return true;
    await 睡(Math.min(0.05, 截止 - 现在秒()));
  }
  return 已停止();
}

function 取号还在跑() {
  return 取号进行中 > 0;
}

async function 取号循环() {
  取号进行中 += 1;
  let 上次请求 = 0;
  const 已停止 = () => 取号停止;
  try {
    while (!取号停止) {
      const 阶段 = _阶段();
      if (阶段 === "停止" || 阶段 === "已满") return;
      if (上次请求) {
        const 剩余 = 库.间隔 - (现在秒() - 上次请求);
        if (剩余 > 0 && (await 可中断等待(剩余, 已停止))) return;
      }
      if (占一个名额() !== "可以") {
        await 睡(0.05);
        continue;
      }
      const 用演示 = 库.演示模式;
      if (!用演示 && !(await 等一个名额(已停止))) {
        退回在途();
        return;
      }
      上次请求 = 现在秒();
      try {
        const 数据 = 用演示 ? 造演示号码() : await 请求接口("get_mobile", { token: 库.token });
        const [成功, 号码, 编号, 归属, 消息] = 解析手机号(数据);
        if (!成功) {
          退回在途();
          写日志(消息 || "取号失败");
          if (取号停止) continue;
          失败原因 = 消息 || "取号失败";
          continue;
        }
        失败原因 = "";
        const 记录 = 记下(号码, 编号, 归属, 用演示);
        if (!锁定当前) 当前记录 = 记录;
        写日志(`取到 ${记录.手机号码}`);
      } catch (错误) {
        退回在途();
        写日志("取号异常: " + 错误);
      }
    }
  } finally {
    取号进行中 -= 1;
  }
}

function 启动取号() {
  const 数量 = Math.min(16, Math.max(1, 数字框("线程框")));
  取号停止 = false;
  for (let i = 0; i < 数量; i += 1) 取号循环();
}

function 停止取号() {
  请求停止();
  取号停止 = true;
}

async function 查一个码(编号, 用演示) {
  收码中[编号] = true;
  try {
    const 数据 = 用演示
      ? 造演示验证码(查询次数[编号])
      : await 请求接口("get_verifycode", { token: 库.token, mid: 编号 });
    const [收到, 验证码, 信息] = 解析验证码(数据);
    if (!收到) return;
    const 记录 = 记下验证码(编号, 验证码, 信息);
    if (!记录) return;
    上次查余额 = 0;
    if (当前记录 && 当前记录.任务编号 === 记录.任务编号) 当前记录 = 记录;
    写日志(`收到 ${记录.手机号码} 验证码 ${记录.验证码} | ${记录.短信内容}`);
  } catch (错误) {
    写日志("收码异常: " + 错误);
  } finally {
    delete 收码中[编号];
  }
}

async function 收码循环() {
  const 已停止 = () => 收码停止;
  while (!收码停止) {
    const [要查, 超时] = 取待收码();
    for (const 号 of 超时) 写日志(`收码超时 ${号.手机号码}`);
    const 现在 = 现在秒();
    const 编号 = 要查.find((编) => !收码中[编] && (!(编 in 上次查询) || 现在 - 上次查询[编] >= 收码间隔秒));
    if (编号 === undefined || Object.keys(收码中).length >= 收码并发) {
      await 睡(0.1);
      continue;
    }
    const 号 = 找号(编号);
    if (!号) continue;
    if (!号.演示 && !库.token) {
      上次查询[编号] = 现在秒();
      continue;
    }
    if (!号.演示 && !(await 等一个名额(已停止))) return;
    上次查询[编号] = 现在秒();
    查询次数[编号] = (查询次数[编号] || 0) + 1;
    查一个码(编号, 号.演示);
  }
}

function 设胶囊(id, 文字, 颜色) {
  const 节点 = $(id);
  节点.textContent = 文字;
  节点.className = "胶囊 " + 颜色;
}

function 写日志(文本) {
  const 行 = new Date().toTimeString().slice(0, 8) + " " + 文本;
  日志行.push(行);
  if (日志行.length > 300) 日志行 = 日志行.slice(-300);
  const 框 = $("日志框");
  if (!$("日志窗").hidden) 框.textContent = 日志行.join("\n");
}

function 看提示色(文字) {
  if (/错误|失败|请先|请输入/.test(文字)) return "红";
  if (/成功|已取满|已重新收码|正在取号/.test(文字)) return "绿";
  if (/老号/.test(文字)) return "金";
  return "";
}

function 设状态说明(文字, 颜色) {
  const 节点 = $("状态说明");
  const 色 = 颜色 === undefined ? 看提示色(文字) : 颜色;
  节点.textContent = 文字;
  节点.className = 色 || "弱";
}

function 记状态原文() {
  if (临时状态到) return;
  状态原文 = $("状态说明").textContent;
  状态原色 = $("状态说明").className === "弱" ? "" : $("状态说明").className;
}

function 写状态(文字, 暂停, 颜色) {
  设胶囊("运行胶囊", 暂停 ? "已暂停" : "取号中", 暂停 ? "灰" : "绿");
  const 色 = 颜色 === undefined ? 看提示色(文字) : 颜色;
  if (临时状态到 && 现在秒() < 临时状态到) {
    状态原文 = 文字;
    状态原色 = 色;
    return;
  }
  临时状态到 = 0;
  临时状态文字 = "";
  临时状态色 = "";
  设状态说明(文字, 色);
}

function 显示一句(文字, 停留秒) {
  写日志(文字);
  const 色 = 看提示色(文字);
  const 取号中 = 已启动 || 取号还在跑();
  if (停留秒 && 取号中) {
    记状态原文();
    临时状态文字 = 文字;
    临时状态色 = 色;
    设状态说明(文字, 色);
    临时状态到 = 现在秒() + 停留秒;
    return;
  }
  临时状态到 = 0;
  临时状态文字 = "";
  临时状态色 = "";
  设状态说明(文字, 色);
}

function 刷连接按钮() {
  $("连接按钮").textContent = 已连接 ? "断开连接" : "连接账号";
  $("账号框").readOnly = 已连接;
  $("密码框").readOnly = 已连接;
}

async function 查一次余额(静默) {
  if (正在查余额 || $("演示框").checked) return;
  const token = 库.token;
  if (!token) return;
  正在查余额 = true;
  上次查余额 = 现在秒();
  const 代号 = 连接代号;
  if (!静默) {
    $("连接按钮").disabled = true;
    写日志("正在查询余额");
  }
  const 数据 = await 请求接口("balance", { token });
  if (代号 !== 连接代号) {
    正在查余额 = false;
    if (!静默) $("连接按钮").disabled = false;
    return;
  }
  正在查余额 = false;
  $("连接按钮").disabled = false;
  if (token !== 库.token) return;
  const [成功, 文本, 消息] = 解析余额(数据);
  if (成功) {
    已连接 = true;
    设胶囊("连接状态", "已连接", "绿");
    刷连接按钮();
    const 新文 = "余额  " + 文本;
    if ($("余额标签").textContent !== 新文 || !静默) 写日志("余额 " + 文本);
    $("余额标签").textContent = 新文;
    return;
  }
  if (静默) {
    if ($("连接状态").textContent !== "连接异常") 写日志("查询余额失败: " + (消息 || "连接失败"));
    设胶囊("连接状态", "连接异常", "红");
    return;
  }
  已连接 = false;
  库.token = "";
  保存配置();
  设胶囊("连接状态", "未连接", "红");
  $("余额标签").textContent = "余额  —";
  刷连接按钮();
  写状态(消息 || "连接失败", true, "红");
  写日志(消息 || "连接失败");
}

function 断开账号() {
  连接代号 += 1;
  已连接 = false;
  库.token = "";
  正在查余额 = false;
  保存配置();
  设胶囊("连接状态", "未连接", "灰");
  $("余额标签").textContent = "余额  —";
  刷连接按钮();
  if (取号还在跑()) {
    正在停止 = true;
    停止取号();
    写状态("已暂停，正在等待当前请求完成并保存结果。", true);
  }
  写日志("已断开连接");
}

async function 去登录(账号, 密码) {
  连接代号 += 1;
  const 代号 = 连接代号;
  $("连接按钮").disabled = true;
  写日志("正在登录");
  const 数据 = await 请求登录(账号, 密码);
  if (代号 !== 连接代号) {
    $("连接按钮").disabled = false;
    return;
  }
  $("连接按钮").disabled = false;
  const token = 数据 && 数据.data && typeof 数据.data.token === "string" ? 数据.data.token : "";
  if (!是成功(数据) || !token) {
    已连接 = false;
    库.token = "";
    设胶囊("连接状态", "未连接", "红");
    刷连接按钮();
    写状态(数据.msg || "连接失败", true, "红");
    写日志(数据.msg || "连接失败");
    return;
  }
  库.token = token;
  保存配置();
  查一次余额(false);
}

function 点连接() {
  if (已连接) {
    断开账号();
    return;
  }
  if ($("演示框").checked) {
    已连接 = true;
    设胶囊("连接状态", "已连接", "绿");
    $("余额标签").textContent = "余额  演示";
    刷连接按钮();
    写状态("演示模式，未访问网络", true);
    写日志("演示模式，未访问网络");
    return;
  }
  const 账号 = $("账号框").value.trim();
  const 密码 = $("密码框").value;
  if (!账号 || !密码) {
    写状态("请输入账号和密码", true);
    return;
  }
  去登录(账号, 密码);
}

function 可以开跑() {
  if (取号还在跑()) return false;
  if (!$("演示框").checked && !已连接) {
    写状态("请先连接账号", true);
    return false;
  }
  return true;
}

function 跑起来(日志) {
  已启动 = true;
  正在停止 = false;
  失败原因 = "";
  写日志(日志);
  写状态("正在取号", false);
  启动取号();
}

function 点开始() {
  if (!可以开跑()) return;
  开始新批次();
  跑起来("开始新批次，线程 " + 数字框("线程框"));
}

function 点继续() {
  if (!可以开跑()) return;
  if (!继续取号()) {
    写状态("本批已取满，请开始新批次", true);
    return;
  }
  跑起来("继续取号");
}

function 点停止() {
  if (!取号还在跑()) return;
  正在停止 = true;
  停止取号();
  写状态("已暂停，正在等待当前请求完成并保存结果。", true);
}

function 看是否收尾() {
  if (!已启动) return;
  if (取号还在跑()) {
    if (正在停止) {
      写状态("已暂停，正在等待当前请求完成并保存结果。", true);
      return;
    }
    if (库.本批已取 >= 库.目标) 写状态("本批已取满", false);
    else if (失败原因) 写状态(失败原因, false, "红");
    else 写状态("正在取号", false);
    return;
  }
  已启动 = false;
  正在停止 = false;
  请求停止();
  const 数 = 统计();
  if (数.本批已取 >= 数.目标) 写状态("本批已取满", true);
  else if (失败原因) 写状态(失败原因, true, "红");
  else 写状态("已暂停", true);
}

function 刷按钮() {
  const 在跑 = 取号还在跑();
  const 数 = 统计();
  $("开始按钮").disabled = 在跑;
  $("继续按钮").disabled = 在跑 || 数.本批已取 >= 数.目标;
  $("停止按钮").disabled = !在跑;
  $("线程框").disabled = 在跑;
  $("演示框").disabled = 在跑;
}

function 刷统计() {
  const 数 = 统计();
  $("批次标签").textContent = `${数.本批已取} / ${数.目标}`;
  $("待用标签").textContent = String(数.待使用);
  $("轮询标签").textContent = String(Object.keys(库.待收码).length);
  $("收码标签").textContent = String(数.已收码);
  $("已用标签").textContent = String(数.已使用);
}

function 状态类(文字, 是验证码) {
  if (是验证码 || 文字 === "已收码" || 文字 === "成功") return "绿字";
  if (文字 === "错误" || String(文字).startsWith("已停止")) return "红字";
  if (文字 === "老号") return "金字";
  if (文字 === "待使用") return "黄字";
  if (String(文字).startsWith("轮询中")) return "蓝字";
  if (文字 === "已使用" || 文字 === "—") return "灰字";
  return "";
}

function 刷当前卡() {
  const 记录 = 当前记录;
  if (!记录) {
    设胶囊("当前状态", "待使用", "灰");
    $("当前信息").textContent = "还没有号码";
    $("大号").textContent = "—";
    $("验证码标签").textContent = "验证码  —";
    $("短信标签").textContent = "";
    $("复制按钮").disabled = true;
    $("复制码按钮").disabled = true;
    $("标记按钮").disabled = true;
    return;
  }
  const 可标记 = 记录.状态 === "待使用" || 记录.状态 === "已收码";
  let 色 = "灰";
  if (记录.状态 === "成功" || 可标记) 色 = "绿";
  if (记录.状态 === "错误") 色 = "红";
  if (记录.状态 === "老号") 色 = "金";
  设胶囊("当前状态", 记录.状态, 色);
  $("当前信息").textContent = `${记录.归属地}  ${记录.获取时间}`;
  $("大号").textContent = 记录.手机号码;
  const 验证码 = 记录.验证码 || "";
  const 收码 = 收码状态()[记录.任务编号] || "";
  if (验证码) $("验证码标签").textContent = "验证码  " + 验证码;
  else if (收码.startsWith("已停止")) $("验证码标签").textContent = 收码 + "，可重新收码";
  else if (收码) $("验证码标签").textContent = 收码;
  else $("验证码标签").textContent = "验证码  —";
  $("短信标签").textContent = 记录.短信内容 || "";
  $("复制按钮").disabled = false;
  $("复制码按钮").disabled = !验证码;
  $("标记按钮").disabled = !可标记;
}

function 做格(文字, 类名) {
  const 格 = document.createElement("td");
  格.textContent = 文字;
  if (类名) 格.className = 类名;
  return 格;
}

function 刷表格(强制) {
  const 列表 = 筛选号码();
  const 收码 = 收码状态();
  $("条数标签").textContent = `共 ${列表.length} 条`;
  const 签名 = 列表.map((号) => `${号.任务编号}|${号.状态}|${号.验证码}`).join(";");
  const 只多了新行 = 表格签名 !== "" && 签名.startsWith(表格签名 + ";");
  const 体 = $("表体");
  if (!强制 && (签名 === 表格签名 || 只多了新行)) {
    表格签名 = 签名;
    const 行们 = 体.rows;
    列表.forEach((号, 行号) => {
      if (行号 >= 行们.length) {
        体.append(做行(号, 收码));
        return;
      }
      const 行 = 行们[行号];
      const 行类 = 当前记录 && 当前记录.任务编号 === 号.任务编号 ? "选中" : "";
      if (行.className !== 行类) 行.className = 行类;
      const 格 = 行.cells[4];
      const 文字 = 号.验证码 || 收码[号.任务编号] || "—";
      if (格.textContent !== 文字) {
        格.textContent = 文字;
        格.className = 状态类(文字, !!号.验证码);
      }
    });
    return;
  }
  表格签名 = 签名;
  体.replaceChildren();
  for (const 号 of 列表) 体.append(做行(号, 收码));
}

function 做行(号, 收码) {
  const 行 = document.createElement("tr");
  if (当前记录 && 当前记录.任务编号 === 号.任务编号) 行.className = "选中";
  行.append(
    做格(号.状态, 状态类(号.状态)),
    做格(号.手机号码),
    做格(号.归属地),
    做格(号.获取时间),
    做格(号.验证码 || 收码[号.任务编号] || "—", 状态类(号.验证码 || 收码[号.任务编号] || "—", !!号.验证码)),
    做格(号.短信内容 || "—", "短信"),
  );
  const 操作 = document.createElement("td");
  操作.className = "操作";
  const 复制 = document.createElement("button");
  复制.type = "button";
  复制.className = "小按钮";
  复制.textContent = "复制";
  复制.addEventListener("click", (事件) => {
    事件.stopPropagation();
    复制文本(号.手机号码, 复制);
  });
  const 标记 = document.createElement("button");
  标记.type = "button";
  标记.className = "小按钮";
  标记.textContent = "标记已用";
  标记.disabled = !(号.状态 === "待使用" || 号.状态 === "已收码");
  标记.addEventListener("click", (事件) => {
    事件.stopPropagation();
    点标记(号.任务编号);
  });
  const 更多 = document.createElement("button");
  更多.type = "button";
  更多.className = "小按钮";
  更多.textContent = "更多";
  更多.addEventListener("click", (事件) => {
    事件.stopPropagation();
    打开更多(号, 更多);
  });
  操作.append(复制, 标记, 更多);
  行.append(操作);
  行.addEventListener("click", () => {
    当前记录 = 找号(号.任务编号);
    锁定当前 = true;
    刷当前卡();
    刷表格(true);
  });
  return 行;
}

function 打开更多(号, 按钮) {
  const 菜单 = $("更多菜单");
  菜单.replaceChildren();
  const 项 = [
    ["重新收码", 号.状态 === "待使用", () => 点重新收码(号.任务编号)],
    ["成功", 号.状态 !== "成功", () => 点标记状态(号.任务编号, "成功")],
    ["错误", 号.状态 !== "错误", () => 点标记状态(号.任务编号, "错误")],
    ["老号", 号.状态 !== "老号", () => 点标记状态(号.任务编号, "老号")],
    ["删除", true, () => 点删除(号.任务编号)],
  ];
  for (const [文字, 可用, 动作] of 项) {
    const 钮 = document.createElement("button");
    钮.type = "button";
    钮.textContent = 文字;
    钮.disabled = !可用;
    钮.addEventListener("click", () => {
      菜单.hidden = true;
      动作();
    });
    菜单.append(钮);
  }
  const 矩形 = 按钮.getBoundingClientRect();
  菜单.hidden = false;
  let 左 = 矩形.right - 菜单.offsetWidth;
  let 上 = 矩形.bottom + 4;
  if (上 + 菜单.offsetHeight > window.innerHeight - 8) 上 = 矩形.top - 菜单.offsetHeight - 4;
  if (左 < 8) 左 = 8;
  if (上 < 8) 上 = 8;
  菜单.style.left = 左 + "px";
  菜单.style.top = 上 + "px";
}

function 闪一下(按钮, 文字) {
  const 原来 = 按钮.dataset.原文 || 按钮.textContent;
  按钮.dataset.原文 = 原来;
  按钮.textContent = 文字;
  setTimeout(() => {
    按钮.textContent = 原来;
    delete 按钮.dataset.原文;
  }, 700);
}

async function 复制文本(文字, 按钮) {
  let 成功 = true;
  try {
    await navigator.clipboard.writeText(文字);
  } catch (错误) {
    const 框 = document.createElement("textarea");
    框.value = 文字;
    框.style.position = "fixed";
    框.style.opacity = "0";
    document.body.append(框);
    框.select();
    框.setSelectionRange(0, 文字.length);
    成功 = document.execCommand("copy");
    框.remove();
  }
  写日志((成功 ? "已复制 " : "复制失败 ") + 文字);
  if (按钮) 闪一下(按钮, 成功 ? "已复制" : "复制失败");
}

function 点标记(编号) {
  const 记录 = 标记已用(编号);
  if (!记录) return;
  if (当前记录 && 当前记录.任务编号 === String(编号)) {
    当前记录 = 记录;
    锁定当前 = false;
  }
  写日志("已标记已用 " + 记录.手机号码);
  刷当前卡();
  刷表格(true);
  刷统计();
}

function 点删除(编号) {
  const 号 = 找号(编号);
  if (!号 || !confirm(`确定删除 ${号.手机号码}？`)) return;
  const 记录 = 删除号码(编号);
  if (!记录) return;
  if (当前记录 && 当前记录.任务编号 === String(编号)) {
    当前记录 = null;
    锁定当前 = false;
  }
  写日志("已删除 " + 记录.手机号码);
  刷当前卡();
  刷表格(true);
  刷统计();
}

const 反馈状态码 = { 成功: "20", 错误: "32", 老号: "31" };

async function 点标记状态(编号, 状态) {
  if (!反馈状态码[状态]) return;
  const 目标 = String(编号);
  const 现有 = 库.列表.find((条) => 条.任务编号 === 目标);
  if (!现有 || 现有.状态 === 状态) return;
  if (!$("演示框").checked) {
    if (!已连接 || !库.token) {
      显示一句("请先连接账号", 4);
      return;
    }
    const 数据 = await 请求接口("feedback", {
      token: 库.token,
      mid: 目标,
      status: 反馈状态码[状态],
    });
    if (!是成功(数据)) {
      显示一句(`${数据.msg || "反馈" + 状态 + "失败"} ${现有.手机号码}`, 4);
      return;
    }
  }
  const 记录 = 标记状态(编号, 状态);
  if (!记录) return;
  if (当前记录 && 当前记录.任务编号 === 目标) {
    当前记录 = 记录;
    锁定当前 = false;
  }
  显示一句(`已标记${状态} ${记录.手机号码}`, 4);
  刷当前卡();
  刷表格(true);
  刷统计();
}

function 点重新收码(编号) {
  if (!重新收码(编号)) return;
  const 号 = 找号(编号);
  写日志("重新收码 " + (号 ? 号.手机号码 : ""));
  记状态原文();
  临时状态文字 = "已重新收码";
  临时状态色 = "绿";
  设状态说明("已重新收码", "绿");
  临时状态到 = 现在秒() + 1;
}

function 导出() {
  const 列表 = 筛选号码();
  const 列 = ["手机号码", "任务编号", "归属地", "获取时间", "状态", "验证码", "短信内容"];
  const 行 = [列.join(",")];
  for (const 号 of 列表) {
    行.push(列.map((键) => `"${String(号[键] || "").replace(/"/g, '""')}"`).join(","));
  }
  const 文件 = new Blob(["\uFEFF" + 行.join("\n")], { type: "text/csv;charset=utf-8" });
  const 链接 = document.createElement("a");
  链接.href = URL.createObjectURL(文件);
  链接.download = "号码记录.csv";
  链接.click();
  setTimeout(() => URL.revokeObjectURL(链接.href), 1000);
  写日志(`已导出 ${列表.length} 条`);
  闪一下($("导出按钮"), "已导出");
}

function 定时刷() {
  if (当前记录) {
    const 最新 = 找号(当前记录.任务编号);
    if (最新) 当前记录 = 最新;
  }
  if (临时状态到) {
    if (现在秒() < 临时状态到) 设状态说明(临时状态文字, 临时状态色);
    else {
      临时状态到 = 0;
      临时状态文字 = "";
      临时状态色 = "";
      if (!已启动) 设状态说明(状态原文, 状态原色);
    }
  }
  看是否收尾();
  if (已连接 && !$("演示框").checked && !正在查余额 && 现在秒() - 上次查余额 >= 余额刷新秒) {
    查一次余额(true);
  }
  刷统计();
  刷当前卡();
  刷表格(false);
  刷按钮();
}

function 填配置() {
  const 配置 = 读配置();
  $("账号框").value = 配置.账号;
  库.token = 配置.token;
  $("目标框").value = 配置.目标;
  $("间隔框").value = 配置.间隔;
  $("线程框").value = 配置.线程数;
  $("轮询框").value = 配置.短信轮询;
  $("演示框").checked = 配置.演示模式;
  更新参数();
}

function 绑定() {
  $("连接按钮").addEventListener("click", 点连接);
  $("开始按钮").addEventListener("click", 点开始);
  $("继续按钮").addEventListener("click", 点继续);
  $("停止按钮").addEventListener("click", 点停止);
  $("复制按钮").addEventListener("click", () => {
    if (!当前记录) return;
    锁定当前 = true;
    复制文本(当前记录.手机号码, $("复制按钮"));
  });
  $("复制码按钮").addEventListener("click", () => {
    if (!当前记录 || !当前记录.验证码) return;
    锁定当前 = true;
    复制文本(当前记录.验证码, $("复制码按钮"));
  });
  $("标记按钮").addEventListener("click", () => {
    if (!当前记录) return;
    点标记(当前记录.任务编号);
    闪一下($("标记按钮"), "已标记");
  });
  $("导出按钮").addEventListener("click", 导出);
  $("清空按钮").addEventListener("click", () => {
    if (!库.列表.length) return;
    if (!confirm("确定清空全部号码？")) return;
    清空号码();
    当前记录 = null;
    锁定当前 = false;
    写日志("已清空号码列表");
    刷当前卡();
    刷表格(true);
    刷统计();
  });
  $("日志按钮").addEventListener("click", () => {
    $("日志框").textContent = 日志行.join("\n");
    $("日志窗").hidden = false;
  });
  $("关日志").addEventListener("click", () => {
    $("日志窗").hidden = true;
  });
  $("目标框").addEventListener("change", () => { 更新参数(); 保存配置(); });
  $("间隔框").addEventListener("change", () => { 更新参数(); 保存配置(); });
  $("线程框").addEventListener("change", 保存配置);
  $("轮询框").addEventListener("change", 保存配置);
  $("演示框").addEventListener("change", () => {
    保存配置();
    if (!$("演示框").checked && 已连接 && !库.token) 断开账号();
  });
  $("账号框").addEventListener("input", () => {
    if (!已连接) 设胶囊("连接状态", "未连接", "灰");
    保存配置();
  });
  $("搜索框").addEventListener("input", () => 刷表格(true));
  for (const 按钮 of document.querySelectorAll(".筛选按钮")) {
    按钮.addEventListener("click", () => {
      筛选 = 按钮.dataset.筛选;
      for (const 项 of document.querySelectorAll(".筛选按钮")) 项.classList.remove("选中");
      按钮.classList.add("选中");
      刷表格(true);
    });
  }
  document.addEventListener("click", () => {
    $("更多菜单").hidden = true;
  });
  window.addEventListener("beforeunload", (事件) => {
    保存配置();
    if (取号还在跑()) {
      事件.preventDefault();
      事件.returnValue = "";
    }
  });
}

读号码();
填配置();
恢复收码();
if (库.列表.length) 当前记录 = { ...库.列表[库.列表.length - 1] };
绑定();
if (库.token && !$("演示框").checked) 查一次余额(true);
刷当前卡();
刷表格(true);
刷统计();
刷按钮();
收码循环();
setInterval(定时刷, 200);
