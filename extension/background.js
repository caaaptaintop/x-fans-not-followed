importScripts("logic.js");

var mem = null;

function freshState() {
  return {
    phase: "idle",
    scanned: 0,
    pending: 0,
    people: [],
    verdict: {},
    quality: {},
    error: "",
    note: "",
    me: null,
    cursor: "",
    removed: {},
    spam: {},
    updatedAt: Date.now(),
  };
}

async function loadState() {
  if (mem) return mem;
  var stored = await chrome.storage.local.get("fanbackState");
  mem = Object.assign(freshState(), stored.fanbackState || {});
  if (!mem.verdict) mem.verdict = {};
  if (!mem.quality) mem.quality = {};
  if (!mem.people) mem.people = [];
  if (!mem.removed) mem.removed = {};
  if (!mem.spam) mem.spam = {};
  return mem;
}

async function saveState(state) {
  state.updatedAt = Date.now();
  state.pending = state.people.length;
  mem = state;
  var payload = {
    phase: state.phase,
    scanned: state.scanned,
    pending: state.pending,
    people: state.people,
    verdict: state.verdict,
    quality: state.quality,
    error: state.error || "",
    note: state.note || "",
    me: state.me || null,
    cursor: state.cursor || "",
    removed: state.removed || {},
    spam: state.spam || {},
    updatedAt: state.updatedAt,
  };
  try {
    await chrome.storage.local.set({ fanbackState: payload });
  } catch (err) {
    payload.people = payload.people.map(function (person) {
      return Object.assign({}, person, { bio: "" });
    });
    await chrome.storage.local.set({ fanbackState: payload });
  }
}

async function ensureTab() {
  var tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] });
  if (tabs.length) return tabs[0];
  return chrome.tabs.create({ url: "https://x.com/home", active: true });
}

function waitUntilComplete(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError || !tab) return resolve();
      if (tab.status === "complete") return resolve();
      function listener(id, info) {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function deliver(tabId, type, mode, cursor) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: type, mode: mode || "", cursor: cursor || "" });
    return true;
  } catch (err) {
    return false;
  }
}

async function startScan(mode) {
  var resume = mode === "resume";
  var previous = await loadState();
  var state = resume ? previous : freshState();
  var cursor = resume ? state.cursor || "" : "";
  if (!resume) state.spam = previous.spam || {};
  if (resume && (!cursor || cursor === "0")) {
    state.phase = "error";
    state.error = "没有可继续的位置。请点重新扫描。";
    await saveState(state);
    return;
  }
  state.phase = "starting";
  state.error = "";
  state.note = resume ? "从上次停下的那一页继续" : "正在读取粉丝列表，一页 200 人";
  if (!resume) state.cursor = "";
  await saveState(state);
  await chrome.storage.local.set({ fanbackActive: true, fanbackResume: false, fanbackMode: resume ? "resume" : "all" });
  var tab = await ensureTab();
  await chrome.storage.local.set({ fanbackTabId: tab.id });
  await waitUntilComplete(tab.id);
  await new Promise(function (resolve) {
    setTimeout(resolve, 400);
  });
  var ok = await deliver(tab.id, "SCAN", resume ? "resume" : "all", cursor);
  if (!ok) {
    await chrome.tabs.update(tab.id, { url: "https://x.com/home", active: true });
    await waitUntilComplete(tab.id);
    await new Promise(function (resolve) {
      setTimeout(resolve, 800);
    });
    ok = await deliver(tab.id, "SCAN", resume ? "resume" : "all", cursor);
  }
  if (!ok) {
    state.phase = "error";
    state.error = "没能连上 X 页面。请打开 x.com 并登录，然后再点一次扫描。";
    await saveState(state);
    await chrome.storage.local.set({ fanbackActive: false });
  }
}

async function stopScan() {
  var stored = await chrome.storage.local.get(["fanbackTabId"]);
  await chrome.storage.local.set({ fanbackActive: false, fanbackResume: false });
  if (stored.fanbackTabId) await deliver(stored.fanbackTabId, "STOP");
  var state = await loadState();
  if (state.phase !== "done" && state.phase !== "error") {
    state.phase = "stopped";
    state.note = "已停止。名单保留刚才扫到的人。";
    await saveState(state);
  }
}

var eventChain = Promise.resolve();

function enqueueEvent(event, sender) {
  eventChain = eventChain
    .then(function () {
      return handleEvent(event, sender);
    })
    .catch(function () {});
}

async function handleEvent(event, sender) {
  if (!event || !event.type) return;
  var state = await loadState();
  if (event.type === "ME") {
    state.me = event.me || null;
    await saveState(state);
    return;
  }
  if (event.type === "STATUS") {
    if (event.phase) state.phase = event.phase;
    if (event.note) state.note = event.note;
    await saveState(state);
    return;
  }
  if (event.type === "NOTE") {
    state.note = event.message || state.note;
    await saveState(state);
    return;
  }
  if (event.type === "CURSOR") {
    state.cursor = event.cursor != null ? String(event.cursor) : "";
    await saveState(state);
    return;
  }
  if (event.type === "FOLLOWED" || event.type === "UNFOLLOWED") {
    var handle = String(event.handle || "").replace(/^@/, "");
    var id = event.id != null ? String(event.id) : "";
    var key = handle.toLowerCase();
    if (event.type === "FOLLOWED") {
      var removed = null;
      state.people = (state.people || []).filter(function (person) {
        var match = (key && person.handle.toLowerCase() === key) || (id && String(person.id) === id);
        if (match) removed = person;
        return !match;
      });
      if (removed) {
        var removedKey = removed.handle.toLowerCase();
        if (!state.removed) state.removed = {};
        state.removed[removedKey] = removed;
        state.verdict[removedKey] = "mutual";
        state.quality[removedKey] = "json";
        state.pending = state.people.length;
        if (["starting", "auth", "rest", "scroll"].indexOf(state.phase) < 0) {
          state.note = "已回关 @" + removed.handle + "，已从名单去掉。";
        }
      }
    } else if (handle) {
      if (state.spam && state.spam[handle.toLowerCase()]) {
        await saveState(state);
        return;
      }
      var backKey = handle.toLowerCase();
      var already = (state.people || []).some(function (person) {
        return person.handle.toLowerCase() === backKey;
      });
      if (!already) {
        var saved = state.removed && state.removed[backKey];
        state.people.push(
          saved || {
            id: id || "dom:" + backKey,
            name: event.name || handle,
            handle: handle,
            bio: "",
            followers: 0,
            following: 0,
            avatar: "",
            verified: false,
            protected: false,
          },
        );
      }
      if (!state.verdict) state.verdict = {};
      state.verdict[backKey] = "pending";
      state.quality[backKey] = "json";
      state.pending = state.people.length;
      if (["starting", "auth", "rest", "scroll"].indexOf(state.phase) < 0) {
        state.note = "已取消对 @" + handle + " 的关注，回到名单里了。";
      }
    }
    await saveState(state);
    return;
  }
  if (event.type === "BATCH") {
    var spam = state.spam || {};
    var users = (event.users || []).filter(function (user) {
      var handle = String(user.handle || "").replace(/^@/, "").toLowerCase();
      if (!handle || spam[handle]) return false;
      if (!state.me) return true;
      return handle !== String(state.me.screenName || "").toLowerCase();
    });
    globalThis.Fanback.mergeBatch(state, users);
    await saveState(state);
    return;
  }
  if (event.type === "NAV" && event.url && sender.tab) {
    state.phase = "scroll";
    state.note = event.note || "正在打开粉丝页";
    await saveState(state);
    await chrome.storage.local.set({ fanbackActive: true, fanbackResume: true, fanbackTabId: sender.tab.id });
    await chrome.tabs.update(sender.tab.id, { url: event.url, active: true });
    return;
  }
  if (event.type === "DONE" || event.type === "STOPPED" || event.type === "ERROR") {
    state.phase = event.type === "ERROR" ? "error" : event.type === "STOPPED" ? "stopped" : "done";
    if (event.type === "ERROR") state.error = event.message || "扫描失败";
    if (event.type === "DONE") {
      state.cursor = "0";
      state.note = state.people.length
        ? "扫完了。点一行，当前这个 X 标签会打开主页。"
        : "扫完了，没有发现「关注了你但你没回关」的账号。";
    }
    if (event.type === "STOPPED" && event.message) state.note = event.message;
    if (event.type === "STOPPED" && !state.note) state.note = "已停止。名单保留刚才扫到的人。";
    await saveState(state);
    await chrome.storage.local.set({ fanbackActive: false, fanbackResume: false });
  }
}

function spamKey(handle) {
  return String(handle || "").replace(/^@/, "").trim().toLowerCase();
}

async function markSpam(handle, undo) {
  var key = spamKey(handle);
  if (!key) return;
  var state = await loadState();
  if (!state.spam) state.spam = {};
  if (!state.verdict) state.verdict = {};
  if (undo) {
    var saved = state.spam[key];
    delete state.spam[key];
    if (state.verdict[key] === "spam") delete state.verdict[key];
    var person = saved && saved.person;
    var exists = (state.people || []).some(function (item) {
      return item.handle.toLowerCase() === key;
    });
    if (person && !exists) {
      state.people.push(person);
      state.verdict[key] = "pending";
      state.quality[key] = "json";
    }
    state.note = "已取消标记 @" + ((saved && saved.handle) || handle) + "。";
  } else {
    var found = null;
    state.people = (state.people || []).filter(function (item) {
      if (item.handle.toLowerCase() !== key) return true;
      found = item;
      return false;
    });
    var shown = (found && found.handle) || String(handle || "").replace(/^@/, "");
    state.spam[key] = {
      handle: shown,
      name: (found && found.name) || shown,
      person: found,
      markedAt: Date.now(),
    };
    state.verdict[key] = "spam";
    state.quality[key] = "json";
    state.note = "已标记 @" + shown + " 为营销或垃圾号，以后扫描都会跳过。";
  }
  state.pending = (state.people || []).length;
  await saveState(state);
}

var panelTabId = null;

function openPanelOnThisTab(tab) {
  if (!chrome.sidePanel || !tab || tab.id == null) return;
  var previous = panelTabId;
  panelTabId = tab.id;
  if (previous != null && previous !== tab.id) {
    chrome.sidePanel.setOptions({ tabId: previous, enabled: false }).catch(function () {});
  }
  chrome.sidePanel
    .setOptions({ tabId: tab.id, path: "dashboard.html", enabled: true })
    .then(function () {
      return chrome.sidePanel.open({ tabId: tab.id });
    })
    .catch(function () {});
}

if (chrome.sidePanel && chrome.sidePanel.setOptions) {
  chrome.sidePanel.setOptions({ enabled: false }).catch(function () {});
}

chrome.action.onClicked.addListener(openPanelOnThisTab);

chrome.tabs.onRemoved.addListener(function (tabId) {
  if (tabId === panelTabId) panelTabId = null;
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return;
  if (message.type === "START") {
    startScan(message.mode)
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: err.message || "启动失败" });
      });
    return true;
  }
  if (message.type === "MARK" || message.type === "UNMARK") {
    eventChain = eventChain.then(function () {
      return markSpam(message.handle, message.type === "UNMARK");
    });
    eventChain
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: err.message || "标记失败" });
      });
    return true;
  }
  if (message.type === "STOP") {
    eventChain = eventChain.then(function () {
      return stopScan();
    });
    eventChain
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: err.message || "停止失败" });
      });
    return true;
  }
  if (message.type === "EVENT") {
    enqueueEvent(message.event, sender);
  }
});
