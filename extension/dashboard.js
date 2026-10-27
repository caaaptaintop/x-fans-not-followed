var state = {
  phase: "idle",
  scanned: 0,
  pending: 0,
  people: [],
  error: "",
  note: "",
  me: null,
};
var filter = "all";
var opened = "";

var $ = function (id) {
  return document.getElementById(id);
};

function formatCount(n) {
  var value = Number(n) || 0;
  return value.toLocaleString("zh-CN");
}

function phaseText() {
  if (state.error && state.phase === "error") return state.error;
  var who = state.me && state.me.screenName ? " @" + state.me.screenName : "";
  var map = {
    idle: "还没扫描。先在这个浏览器登录 x.com。扫描会一页读 200 人，不用自己翻粉丝页。",
    starting: "正在连接 X…",
    auth: "正在确认当前账号…",
    rest: (state.note || "正在读取粉丝列表，一页 200 人。") + who,
    scroll: (state.note || "正在读取。") + who,
    done: (state.note || "扫描完成。") + who,
    stopped: state.note || "已停止。名单还在。",
    error: state.error || "扫描失败",
  };
  return map[state.phase] || state.note || "处理中…";
}

function running() {
  return ["starting", "auth", "rest", "scroll"].indexOf(state.phase) >= 0;
}

function canResume() {
  var cursor = state.cursor != null ? String(state.cursor) : "";
  return !!cursor && cursor !== "0" && cursor !== "-1";
}

function blueCount() {
  var n = 0;
  (state.people || []).forEach(function (person) {
    if (person.verified) n += 1;
  });
  return n;
}

function spamList() {
  var spam = state.spam || {};
  return Object.keys(spam).map(function (key) {
    var item = spam[key] || {};
    return item.person || { handle: item.handle || key, name: item.name || item.handle || key };
  });
}

function filtered() {
  if (filter === "spam") return spamList();
  var rows = (state.people || []).filter(function (person) {
    if (filter === "blue" && !person.verified) return false;
    return true;
  });
  var sort = $("sort").value;
  if (sort === "followers") {
    rows = rows.slice().sort(function (a, b) {
      return (b.followers || 0) - (a.followers || 0);
    });
  } else if (sort === "name") {
    rows = rows.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, "zh");
    });
  }
  return rows;
}

function avatarHtml(person) {
  var letter = (person.name || person.handle || "?").slice(0, 1);
  if (!person.avatar) return '<div class="ph" aria-hidden="true">' + escapeHtml(letter) + "</div>";
  return (
    '<img class="avatar" alt="" referrerpolicy="no-referrer" src="' +
    escapeAttr(person.avatar) +
    '" />'
  );
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;");
}
function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "\u0026quot;");
}

function render() {
  $("stat-pending").textContent = formatCount((state.people || []).length);
  $("stat-blue").textContent = formatCount(blueCount());
  $("stat-scanned").textContent = formatCount(state.scanned || 0);
  $("spam-chip").textContent = "已标记 " + Object.keys(state.spam || {}).length;
  $("status").textContent = phaseText();
  $("error").hidden = state.phase !== "error";
  $("error").textContent = state.error || "";
  $("start").textContent = (state.people || []).length ? "重新扫描" : "开始扫描";
  $("start").disabled = running();
  $("verified").disabled = running();
  $("resume").hidden = running() || !canResume();
  $("stop").hidden = !running();

  var rows = filtered();
  var list = $("list");
  list.innerHTML = rows
    .map(function (person) {
      var cls = "row" + (person.handle === opened ? " selected" : "");
      var badges = "";
      if (person.verified) badges += '<span class="badge">蓝 V</span>';
      if (person.protected) badges += '<span class="badge">私密</span>';
      var fans = person.followers ? formatCount(person.followers) + " 粉丝" : "";
      var action = filter === "spam"
        ? '<button type="button" class="unmark" data-handle="' + escapeAttr(person.handle) + '">撤销</button>'
        : '<button type="button" class="mark" data-handle="' + escapeAttr(person.handle) + '">标记</button>';
      return (
        '<div class="' + cls + '" data-handle="' + escapeAttr(person.handle) + '">' +
        avatarHtml(person) +
        '<span><span class="name-line"><span class="name">' + escapeHtml(person.name) + "</span>" +
        '<span class="handle">@' + escapeHtml(person.handle) + "</span></span>" +
        (person.bio ? '<span class="bio">' + escapeHtml(person.bio) + "</span>" : "") +
        '<span class="meta">' + fans + badges + "</span></span>" +
        action +
        "</div>"
      );
    })
    .join("");
  $("empty").hidden = rows.length > 0;
  $("empty").textContent = filter === "spam" ? "还没有标记过营销或垃圾号。" : "这个筛选下没有人。";
}

function openHere(handle) {
  opened = handle;
  render();
  var go = function () {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab) return;
      chrome.tabs.update(tab.id, { url: "https://x.com/" + handle });
    });
  };
  if (running()) chrome.runtime.sendMessage({ type: "STOP" }, go);
  else go();
}

document.body.addEventListener("error", function (event) {
  var img = event.target;
  if (!img || img.tagName !== "IMG") return;
  var ph = document.createElement("div");
  ph.className = "ph";
  ph.textContent = "?";
  img.replaceWith(ph);
}, true);

$("list").addEventListener("click", function (event) {
  var origin = event.target instanceof Element ? event.target : event.target.parentElement;
  if (!origin || !origin.closest) return;
  var mark = origin.closest(".mark, .unmark");
  if (mark) {
    var marked = mark.getAttribute("data-handle") || "";
    if (!marked) return;
    chrome.runtime.sendMessage({ type: mark.classList.contains("unmark") ? "UNMARK" : "MARK", handle: marked });
    return;
  }
  var row = origin.closest(".row");
  if (!row) return;
  var handle = row.getAttribute("data-handle") || "";
  if (handle && filter !== "spam") openHere(handle);
});

$("sort").addEventListener("change", render);
document.querySelectorAll(".chip").forEach(function (chip) {
  chip.addEventListener("click", function () {
    filter = chip.getAttribute("data-filter");
    document.querySelectorAll(".chip").forEach(function (el) {
      el.classList.toggle("on", el === chip);
    });
    render();
  });
});

function begin(mode) {
  $("start").disabled = true;
  $("verified").disabled = true;
  $("resume").hidden = true;
  chrome.runtime.sendMessage({ type: "START", mode: mode }, function (response) {
    if (chrome.runtime.lastError || (response && response.ok === false)) {
      state.phase = "error";
      state.error = (response && response.error) || chrome.runtime.lastError.message || "启动失败";
      render();
    }
  });
}

$("start").addEventListener("click", function () {
  begin("all");
});
$("resume").addEventListener("click", function () {
  begin("resume");
});
$("verified").addEventListener("click", function () {
  filter = "blue";
  document.querySelectorAll(".chip").forEach(function (el) {
    el.classList.toggle("on", el.getAttribute("data-filter") === "blue");
  });
  render();
  if (!(state.people || []).length && !running()) begin("all");
});

$("stop").addEventListener("click", function () {
  chrome.runtime.sendMessage({ type: "STOP" });
});

$("copy").addEventListener("click", async function () {
  var text = filtered()
    .map(function (person) { return "@" + person.handle; })
    .join("\n");
  try {
    await navigator.clipboard.writeText(text || "");
    $("status").textContent = text ? "已复制 " + filtered().length + " 个用户名。" : "没有可复制的人。";
  } catch (err) {
    $("status").textContent = "复制失败，可以改用导出 CSV。";
  }
});

$("csv").addEventListener("click", function () {
  var rows = filtered();
  var lines = ["名字,用户名,简介,粉丝数,关注数,蓝V,主页"];
  rows.forEach(function (person) {
    var cells = [
      person.name,
      "@" + person.handle,
      person.bio || "",
      person.followers || 0,
      person.following || 0,
      person.verified ? "是" : "否",
      "https://x.com/" + person.handle,
    ].map(function (cell) {
      return '"' + String(cell).replace(/"/g, '""') + '"';
    });
    lines.push(cells.join(","));
  });
  var blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "待回关.csv";
  a.click();
  URL.revokeObjectURL(url);
});

function applyStored(items) {
  if (items.fanbackState) state = Object.assign(state, items.fanbackState);
  render();
}

chrome.storage.local.get(["fanbackState"], applyStored);
chrome.storage.onChanged.addListener(function (changes) {
  if (changes.fanbackState) state = Object.assign(state, changes.fanbackState.newValue || {});
  render();
});
