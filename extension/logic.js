/* Shared, side-effect-free helpers. Loaded in the page world and the service worker. */
(function (root) {
  function pickBool() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === "boolean") return arguments[i];
    }
    return null;
  }

  function cleanHandle(value) {
    return String(value || "")
      .replace(/^@/, "")
      .trim();
  }

  function slim(user, handle) {
    var id = user.id != null ? String(user.id) : "dom:" + handle.toLowerCase();
    return {
      id: id,
      name: user.name || handle,
      handle: handle,
      bio: String(user.bio || "").slice(0, 180),
      followers: Number(user.followers) || 0,
      following: Number(user.following) || 0,
      avatar: user.avatar || "",
      verified: !!user.verified,
      protected: !!user.protected,
    };
  }

  function mergeRich(prev, next) {
    var nextId = next.id && String(next.id).indexOf("dom:") !== 0 ? next.id : prev.id;
    return {
      id: nextId,
      name: next.name && next.name !== next.handle ? next.name : prev.name,
      handle: prev.handle,
      bio: next.bio || prev.bio,
      followers: next.followers || prev.followers,
      following: next.following || prev.following,
      avatar: next.avatar || prev.avatar,
      verified: prev.verified || next.verified,
      protected: prev.protected || next.protected,
    };
  }

  function emptyState() {
    return { people: [], verdict: {}, quality: {}, scanned: 0, pending: 0 };
  }

  /**
   * Fold one batch into the scan state.
   * Pending = they follow you, you do not follow them.
   * JSON beats a DOM guess. A later JSON "you follow them" removes a DOM false positive.
   */
  function mergeBatch(state, users) {
    users = users || [];
    for (var i = 0; i < users.length; i++) {
      var user = users[i];
      if (!user || user.youFollow !== true && user.youFollow !== false) continue;
      var handle = cleanHandle(user.handle);
      if (!handle) continue;
      var key = handle.toLowerCase();
      var incoming = user.youFollow ? "mutual" : "pending";
      var src = user.source === "dom" ? "dom" : "json";
      var prev = state.verdict[key];
      var prevQ = state.quality[key];

      if (!prev) {
        state.verdict[key] = incoming;
        state.quality[key] = src;
        state.scanned += 1;
        if (incoming === "pending") state.people.push(slim(user, handle));
        continue;
      }

      if (prevQ === "json" && src === "dom") {
        var domIdx = -1;
        for (var d = 0; d < state.people.length; d++) {
          if (state.people[d].handle.toLowerCase() === key) domIdx = d;
        }
        if (domIdx >= 0 && !state.people[domIdx].avatar && user.avatar) {
          state.people[domIdx].avatar = user.avatar;
        }
        continue;
      }

      if (prev === "pending" && incoming === "mutual") {
        state.verdict[key] = "mutual";
        state.quality[key] = src;
        state.people = state.people.filter(function (p) {
          return p.handle.toLowerCase() !== key;
        });
        continue;
      }

      if (prev === "pending" && incoming === "pending") {
        var idx = -1;
        for (var p = 0; p < state.people.length; p++) {
          if (state.people[p].handle.toLowerCase() === key) idx = p;
        }
        if (idx >= 0) state.people[idx] = mergeRich(state.people[idx], slim(user, handle));
        if (src === "json") state.quality[key] = "json";
        continue;
      }

      if (prev === "mutual" && incoming === "pending" && prevQ === "dom" && src === "json") {
        state.verdict[key] = "pending";
        state.quality[key] = "json";
        state.people.push(slim(user, handle));
      }
    }
    state.pending = state.people.length;
    return state;
  }

  function mapRestUser(user) {
    if (!user || typeof user.following !== "boolean" || !user.screen_name) return null;
    return {
      id: String(user.id_str || user.id || ""),
      handle: user.screen_name,
      name: user.name || user.screen_name,
      bio: user.description || "",
      followers: user.followers_count || 0,
      following: user.friends_count || 0,
      avatar: String(user.profile_image_url_https || "").replace("_normal", "_bigger"),
      verified: !!(
        user.verified ||
        user.is_blue_verified ||
        user.ext_is_blue_verified ||
        (user.ext_verified_type && user.ext_verified_type !== "None") ||
        (user.verified_type && user.verified_type !== "None")
      ),
      protected: !!user.protected,
      youFollow: user.following,
      followsYou: true,
      source: "json",
    };
  }

  function mapNode(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;

    var legacy = node.legacy && typeof node.legacy === "object" ? node.legacy : null;
    var core = node.core && typeof node.core === "object" ? node.core : null;
    var rel = node.relationship_perspectives;

    if (node.screen_name && (node.id_str || node.id) && typeof node.followers_count === "number") {
      return mapRestUser(node);
    }

    var handle = (core && core.screen_name) || (legacy && legacy.screen_name);
    var id = node.rest_id || (legacy && legacy.id_str);
    if (!handle || !id) return null;

    var youFollow = pickBool(
      rel && rel.following,
      legacy && legacy.following,
      node.following,
    );
    var followsYou = pickBool(
      rel && rel.followed_by,
      legacy && legacy.followed_by,
      node.followed_by,
    );
    if (youFollow === null) return null;
    if (followsYou === false) return null;

    var avatar =
      (node.avatar && node.avatar.image_url) ||
      (legacy && legacy.profile_image_url_https) ||
      "";
    var bio =
      (legacy && legacy.description) ||
      (node.profile_bio && node.profile_bio.description) ||
      "";

    return {
      id: String(id),
      handle: handle,
      name: (core && core.name) || (legacy && legacy.name) || handle,
      bio: bio,
      followers:
        (legacy && legacy.followers_count) ||
        (node.relationship_counts && node.relationship_counts.followers) ||
        0,
      following: (legacy && legacy.friends_count) || 0,
      avatar: String(avatar).replace("_normal", "_bigger"),
      verified: !!(
        node.is_blue_verified ||
        (legacy && legacy.verified) ||
        (node.verification && node.verification.verified)
      ),
      protected: !!(
        (legacy && legacy.protected) ||
        (node.privacy && node.privacy.protected)
      ),
      youFollow: youFollow,
      followsYou: followsYou !== false,
      source: "json",
    };
  }

  function extractUsers(json) {
    var out = [];
    var seen = {};
    function visit(node, depth) {
      if (!node || typeof node !== "object" || depth > 30) return;
      var mapped = mapNode(node);
      if (mapped && mapped.handle) {
        var key = mapped.id + ":" + mapped.handle.toLowerCase();
        if (!seen[key]) {
          seen[key] = true;
          out.push(mapped);
        }
      }
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) visit(node[i], depth + 1);
        return;
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var name = keys[k];
        if (name === "legacy" || name === "entities" || name === "extended_entities") continue;
        var child = node[name];
        if (child && typeof child === "object") visit(child, depth + 1);
      }
    }
    visit(json, 0);
    return out;
  }

  function isFollowersUrl(url) {
    var value = String(url || "");
    return (
      /followers\/list\.json/i.test(value) ||
      /\/Followers(\?|$)/.test(value) ||
      /BlueVerifiedFollowers/.test(value) ||
      /FollowersYouKnow/.test(value)
    );
  }

  root.Fanback = {
    pickBool: pickBool,
    emptyState: emptyState,
    mergeBatch: mergeBatch,
    mapRestUser: mapRestUser,
    extractUsers: extractUsers,
    isFollowersUrl: isFollowersUrl,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
