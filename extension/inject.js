/* Runs in the X page (MAIN world) before the site's own scripts. Read-only. */
(function () {
  if (window.__fanbackInstalled) return;
  window.__fanbackInstalled = true;

  var BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  var listen = false;
  var stopFlag = false;
  var running = false;
  var silent = false;
  var captured = 0;

  function post(payload) {
    if (!listen && payload.type === "BATCH") return;
    window.postMessage(Object.assign({ source: "fanback" }, payload), "*");
  }

  function csrf() {
    var match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function userIdFromCookie() {
    var match = document.cookie.match(/(?:^|;\s*)twid=(?:"|%22)?u(?:%3D|=)(\d+)/);
    return match ? match[1] : "";
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function api(path) {
    silent = true;
    try {
      var token = csrf();
      if (!token) {
        var err = new Error("请先在这个浏览器登录 x.com，刷新后再扫。");
        err.code = "NO_LOGIN";
        throw err;
      }
      var response = await window.__fanbackNativeFetch("https://x.com" + path, {
        credentials: "include",
        headers: {
          authorization: "Bearer " + BEARER,
          "x-csrf-token": token,
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-active-user": "yes",
          accept: "application/json",
        },
      });
      var text = await response.text();
      var data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (e) {
        data = {};
      }
      if (!response.ok) {
        var http = new Error("HTTP " + response.status);
        http.status = response.status;
        http.reset = response.headers.get("x-rate-limit-reset");
        throw http;
      }
      if (data && data.errors && data.errors.length && !data.users && !data.screen_name) {
        var apiErr = new Error(data.errors[0].message || "X 拒绝了这次读取");
        apiErr.status = data.errors[0].code;
        throw apiErr;
      }
      return data;
    } finally {
      silent = false;
    }
  }

  function screenNameFromDom() {
    var link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    var href = link && link.getAttribute("href");
    if (!href) return "";
    var name = href.replace(/^\//, "").split("/")[0];
    if (!name || /^(home|explore|search|settings|i|messages)$/i.test(name)) return "";
    return name;
  }

  async function whoami() {
    var fromDom = "";
    for (var i = 0; i < 16 && !stopFlag; i++) {
      fromDom = screenNameFromDom();
      if (fromDom) break;
      await sleep(400);
    }
    var fromCookie = userIdFromCookie();
    if (fromDom) {
      return { screenName: fromDom, id: fromCookie || "dom:" + fromDom.toLowerCase(), name: fromDom };
    }
    var paths = [
      "/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false",
      "/i/api/1.1/account/settings.json",
    ];
    var lastStatus = 0;
    for (var p = 0; p < paths.length; p++) {
      try {
        var data = await api(paths[p]);
        var screenName = data.screen_name;
        var id = data.id_str || (data.id != null ? String(data.id) : "") || fromCookie;
        if (screenName && id) {
          return { screenName: screenName, id: String(id), name: data.name || screenName };
        }
      } catch (err) {
        lastStatus = err.status || lastStatus;
      }
    }
    if (!csrf() || lastStatus === 401 || lastStatus === 403) {
      throw new Error("读不到登录状态。请在这个浏览器打开 x.com 并确认已经登录，然后回来再点一次扫描。");
    }
    throw new Error("没能确认当前是哪个 X 账号。请先打开 x.com 首页，再点扫描。");
  }

  function absorb(url, body) {
    if (silent || !listen) return;
    if (!window.Fanback || !window.Fanback.isFollowersUrl(url)) return;
    if (typeof body !== "string" || body.length < 40) return;
    if (body.indexOf("screen_name") === -1 && body.indexOf("rest_id") === -1) return;
    var json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      return;
    }
    var users = window.Fanback.extractUsers(json).slice(0, 500);
    if (!users.length) return;
    captured += users.length;
    post({ type: "BATCH", users: users });
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input && input.url) return input.url;
    return "";
  }

  function idsFromBody(body) {
    var text = "";
    if (typeof body === "string") text = body;
    else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) text = body.toString();
    var handle = "";
    var id = "";
    if (!text) return { handle: handle, id: id };
    if (text.charAt(0) === "{") {
      try {
        var json = JSON.parse(text);
        var vars = (json && json.variables) || {};
        if (vars.screen_name || vars.screenName) handle = String(vars.screen_name || vars.screenName);
        if (vars.user_id || vars.userId) id = String(vars.user_id || vars.userId);
      } catch (e) {}
      return { handle: handle, id: id };
    }
    var handleMatch = text.match(/(?:^|&)screen_name=([^&]+)/);
    var idMatch = text.match(/(?:^|&)user_id=([^&]+)/);
    if (handleMatch) handle = decodeURIComponent(handleMatch[1]);
    if (idMatch) id = decodeURIComponent(idMatch[1]);
    return { handle: handle, id: id };
  }

  function relationshipKind(url) {
    var value = String(url || "");
    if (/friendships\/create\.json/i.test(value) || /\/(?:Follow|CreateFriendship|FriendshipsCreate)(\?|$)/.test(value)) {
      return "follow";
    }
    if (/friendships\/destroy\.json/i.test(value) || /\/(?:Unfollow|DestroyFriendship|FriendshipsDestroy)(\?|$)/.test(value)) {
      return "unfollow";
    }
    return "";
  }

  function noteRelationship(url, reqBody, resText, ok) {
    var kind = relationshipKind(url);
    if (!kind || !ok) return;
    var fromReq = idsFromBody(reqBody);
    var handle = fromReq.handle;
    var id = fromReq.id;
    var followedBy = null;
    try {
      var json = JSON.parse(resText || "");
      if (json && json.screen_name) handle = json.screen_name;
      if (json && (json.id_str || json.id)) id = String(json.id_str || json.id);
      if (json && typeof json.followed_by === "boolean") followedBy = json.followed_by;
      if (kind === "follow" && json && json.following === false) return;
      if (kind === "unfollow" && json && json.following === true) return;
    } catch (e) {}
    if (!handle && !id) return;
    if (kind === "follow") post({ type: "FOLLOWED", handle: handle, id: id });
    else if (followedBy === true) post({ type: "UNFOLLOWED", handle: handle, id: id, name: handle });
  }

  var profileWatch = { handle: "", sawFollow: false, reported: "" };

  function profileHandle() {
    var part = location.pathname.split("/").filter(Boolean)[0] || "";
    if (!part || /^(home|explore|search|settings|i|messages|notifications|compose)$/i.test(part)) return "";
    if (!/^[A-Za-z0-9_]{1,15}$/.test(part)) return "";
    return part;
  }

  function checkProfileFollow() {
    var handle = profileHandle();
    var key = handle.toLowerCase();
    if (key !== profileWatch.handle) profileWatch = { handle: key, sawFollow: false, reported: "" };
    if (!handle) return;
    var box = document.querySelector('[data-testid="primaryColumn"] [data-testid="placementTracking"]');
    if (!box) return;
    var hasFollow = !!box.querySelector('[data-testid$="-follow"]');
    var hasUnfollow = !!box.querySelector('[data-testid$="-unfollow"]');
    if (hasFollow && !hasUnfollow) profileWatch.sawFollow = true;
    if (profileWatch.sawFollow && hasUnfollow && profileWatch.reported !== key) {
      profileWatch.reported = key;
      post({ type: "FOLLOWED", handle: handle });
    }
  }

  var nativeFetch = window.fetch.bind(window);
  window.__fanbackNativeFetch = nativeFetch;
  window.fetch = function () {
    var args = arguments;
    var reqBody = args[1] && args[1].body;
    return nativeFetch.apply(window, args).then(function (response) {
      try {
        var url = requestUrl(args[0]);
        var kind = relationshipKind(url);
        if ((window.Fanback && window.Fanback.isFollowersUrl(url)) || kind) {
          response
            .clone()
            .text()
            .then(function (text) {
              if (kind) noteRelationship(url, reqBody, text, response.ok);
              else absorb(url, text);
            })
            .catch(function () {});
        }
      } catch (e) {}
      return response;
    });
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fanbackUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var reqBody = typeof body === "string" ? body : "";
    this.addEventListener("load", function () {
      try {
        var url = String(this.__fanbackUrl || "");
        var kind = relationshipKind(url);
        if (kind) noteRelationship(url, reqBody, this.responseText || "", this.status >= 200 && this.status < 300);
        else absorb(url, this.responseText || "");
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  var watchQueued = false;
  function queueProfileCheck() {
    if (watchQueued) return;
    watchQueued = true;
    setTimeout(function () {
      watchQueued = false;
      try {
        checkProfileFollow();
      } catch (e) {}
    }, 250);
  }
  function armProfileWatch() {
    var root = document.documentElement;
    if (!root || root.__fanbackWatch) return;
    root.__fanbackWatch = true;
    new MutationObserver(queueProfileCheck).observe(root, { childList: true, subtree: true });
  }
  if (document.documentElement) armProfileWatch();
  else document.addEventListener("readystatechange", armProfileWatch);

  function findScroller(node) {
    var current = node;
    while (current && current !== document.documentElement) {
      var style = window.getComputedStyle(current);
      var overflow = style.overflowY;
      if (
        (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
        current.scrollHeight > current.clientHeight + 80
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return window;
  }

  function nearBottom(scroller) {
    if (scroller === window) {
      var root = document.scrollingElement || document.documentElement;
      return root.scrollHeight - window.scrollY - window.innerHeight < 180;
    }
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 180;
  }

  function listLoading() {
    var column = document.querySelector('[data-testid="primaryColumn"]');
    return !!(column && column.querySelector('[role="progressbar"]'));
  }

  function scrollLikePerson() {
    var cells = document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserCell"]');
    var last = cells[cells.length - 1];
    var scroller = findScroller(last || document.querySelector('[data-testid="primaryColumn"]'));
    var view = scroller === window ? window.innerHeight : scroller.clientHeight || window.innerHeight;
    var before = scroller === window ? window.scrollY : scroller.scrollTop;
    var delta = Math.round(view);
    if (scroller === window) window.scrollBy(0, delta);
    else scroller.scrollTop += delta;
    var after = scroller === window ? window.scrollY : scroller.scrollTop;
    if (Math.abs(after - before) < 8 && last && last.scrollIntoView) {
      last.scrollIntoView({ block: "end" });
    }
    return scroller;
  }

  async function waitForPeople() {
    for (var i = 0; i < 24 && !stopFlag; i++) {
      if (document.querySelector('[data-testid="primaryColumn"] [data-testid="UserCell"]')) return true;
      await sleep(700);
    }
    return !!document.querySelector('[data-testid="primaryColumn"] [data-testid="UserCell"]');
  }

  async function scrollCollect() {
    var ready = await waitForPeople();
    if (!ready) {
      post({
        type: "NOTE",
        message: "粉丝页没加载出人。确认这个标签是你自己的粉丝页，并且已经登录，然后再扫一次。",
      });
      return;
    }
    var known = {};
    var idle = 0;
    var stalls = 0;
    var loadingWaits = 0;
    for (var step = 0; step < 900 && !stopFlag; step++) {
      var batch = readDom();
      var added = 0;
      for (var i = 0; i < batch.length; i++) {
        var key = String(batch[i].handle || "").toLowerCase();
        if (!key || known[key]) continue;
        known[key] = true;
        added += 1;
      }
      var beforeCapture = captured;
      var scroller = scrollLikePerson();
      await sleep(600 + Math.random() * 500);
      if (stopFlag) return;
      if (clickRetry()) {
        stalls += 1;
        post({ type: "NOTE", message: "这一屏没加载出来。" });
        await sleep(4000);
        if (stalls >= 2) {
          post({
            type: "NOTE",
            message: "X 限制了继续加载。多等几分钟通常也不会恢复，名单留在已经翻到的人。要看蓝 V，用「只扫蓝 V」，那是单独一页。",
          });
          return;
        }
        continue;
      }
      var grew = added > 0 || captured !== beforeCapture;
      if (grew) {
        idle = 0;
        stalls = 0;
        loadingWaits = 0;
      } else if (listLoading()) {
        loadingWaits += 1;
        if (loadingWaits >= 5) idle += 1;
      } else {
        loadingWaits = 0;
        idle += 1;
      }
      var seenCount = Object.keys(known).length;
      post({
        type: "STATUS",
        phase: "scroll",
        note: "每次往下滚一屏，已翻过 " + seenCount + " 个粉丝。别关掉这个标签",
      });
      if (!listLoading() && idle >= 4 && nearBottom(scroller)) return;
      if (!listLoading() && idle >= 8) {
        post({
          type: "NOTE",
          message: "后面没有再加载出新人。如果还没到列表底部，就是 X 的限制，多等几分钟通常没用。名单留在已经翻到的人。",
        });
        return;
      }
    }
    post({ type: "NOTE", message: "这一次先停在目前看到的人。" });
  }

  function waitText(reset) {
    var sec = Number(reset);
    if (!sec) return "过一会儿再点继续。";
    var left = sec * 1000 - Date.now();
    var min = Math.max(1, Math.ceil(left / 60000));
    return "大约 " + min + " 分钟后可以点继续。";
  }

  async function accountId(me) {
    if (me && me.id && /^\d+$/.test(String(me.id))) return String(me.id);
    var data = await api("/i/api/1.1/account/verify_credentials.json?skip_status=true&include_entities=false");
    var id = data.id_str || (data.id != null ? String(data.id) : "");
    if (!id) throw new Error("没能读到账号 ID。请刷新 x.com 后再扫。");
    return String(id);
  }

  async function scanRest(startCursor) {
    post({ type: "STATUS", phase: "auth", note: "正在确认当前账号" });
    var me = await whoami();
    post({ type: "ME", me: me });
    if (stopFlag) {
      post({ type: "STOPPED" });
      return;
    }
    var id = await accountId(me);
    var cursor = startCursor && String(startCursor) !== "0" ? String(startCursor) : "-1";
    var page = 0;
    while (!stopFlag) {
      post({ type: "CURSOR", cursor: cursor });
      var path =
        "/i/api/1.1/followers/list.json?user_id=" +
        encodeURIComponent(id) +
        "&count=200&skip_status=true&include_user_entities=false" +
        "&include_ext_is_blue_verified=true&include_ext_verified_type=true" +
        "&cursor=" +
        encodeURIComponent(cursor);
      var data;
      try {
        data = await api(path);
      } catch (err) {
        if (err.status === 429 || err.status === 503) {
          post({
            type: "NOTE",
            message: "这一页被 X 限制了。" + waitText(err.reset) + " 已经读到的人还在，到点点继续，不会从头再读。",
          });
          post({ type: "STOPPED" });
          return;
        }
        throw err;
      }
      var raw = data.users || [];
      var users = [];
      for (var i = 0; i < raw.length; i++) {
        var mapped = window.Fanback.mapRestUser(raw[i]);
        if (mapped) users.push(mapped);
      }
      if (users.length) post({ type: "BATCH", users: users });
      page += 1;
      var next =
        data.next_cursor_str != null
          ? String(data.next_cursor_str)
          : String(data.next_cursor != null ? data.next_cursor : "0");
      post({
        type: "STATUS",
        phase: "rest",
        note: "一页 200 人，已读 " + page + " 页，这一页 " + raw.length + " 人。X 标签可以留着，不用翻页。",
      });
      if (!next || next === "0" || next === cursor) {
        post({ type: "DONE", cursor: "0" });
        return;
      }
      cursor = next;
      post({ type: "CURSOR", cursor: cursor });
      await sleep(1200 + Math.random() * 800);
    }
    post({ type: "STOPPED" });
  }

  async function scan() {
    await scanRest("-1");
  }
  function clickRetry() {
    var buttons = document.querySelectorAll("button, [role='button']");
    for (var i = 0; i < buttons.length; i++) {
      var text = (buttons[i].innerText || "").trim();
      if (/^(重试|Retry|Try again)$/i.test(text)) {
        buttons[i].click();
        return true;
      }
    }
    return false;
  }

  function onListPage(screenName, mode) {
    var path = location.pathname.toLowerCase().replace(/\/$/, "");
    var name = String(screenName || "").toLowerCase();
    if (mode === "verified") {
      return name ? path === "/" + name + "/verified_followers" : /\/verified_followers$/.test(path);
    }
    if (mode === "all" && name) return path === "/" + name + "/followers";
    return /\/followers$/.test(path) || /\/verified_followers$/.test(path);
  }

  function readDom() {
    if (!onListPage("", "")) return [];
    var onVerifiedPage = /\/verified_followers$/.test(location.pathname.toLowerCase().replace(/\/$/, ""));
    var cells = document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserCell"]');
    var users = [];
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var links = cell.querySelectorAll('a[href^="/"]');
      var handle = "";
      for (var j = 0; j < links.length; j++) {
        var href = links[j].getAttribute("href") || "";
        var match = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
        if (!match) continue;
        if (/^(home|explore|search|settings|i|messages|notifications|compose)$/i.test(match[1])) continue;
        handle = match[1];
        break;
      }
      if (!handle) continue;
      if (cell.querySelector('[data-testid$="-unfollow"]')) {
        users.push({ handle: handle, youFollow: true, followsYou: true, source: "dom", name: handle });
        continue;
      }
      if (!cell.querySelector('[data-testid$="-follow"]')) continue;
      var img = cell.querySelector("img");
      var nameNode = cell.querySelector('[data-testid="User-Name"] span');
      users.push({
        id: "dom:" + handle.toLowerCase(),
        handle: handle,
        name: (nameNode && nameNode.textContent) || handle,
        bio: "",
        followers: 0,
        following: 0,
        avatar: (img && img.src) || "",
        verified: onVerifiedPage || !!cell.querySelector('[data-testid="icon-verified"]'),
        protected: false,
        youFollow: false,
        followsYou: true,
        source: "dom",
      });
    }
    if (users.length) post({ type: "BATCH", users: users });
    return users;
  }

  async function onCommand(type, mode, cursor) {
    if (type === "STOP") {
      stopFlag = true;
      return;
    }
    if (running) return;
    if (!window.Fanback) {
      post({ type: "ERROR", message: "插件脚本不完整，请重新加载扩展。" });
      return;
    }
    running = true;
    stopFlag = false;
    listen = true;
    try {
      if (type === "SCAN") await scanRest(mode === "resume" ? cursor : "-1");
    } catch (err) {
      var status = err && err.status;
      var message = (err && err.message) || "扫描失败";
      if (status) message = "读取失败（HTTP " + status + "）。名单没有被清掉。";
      post({ type: "ERROR", message: message });
    } finally {
      running = false;
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== "fanback-cmd") return;
    onCommand(data.type, data.mode, data.cursor);
  });
})();
