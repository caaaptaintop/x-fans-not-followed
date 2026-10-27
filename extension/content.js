/* Isolated world bridge: page postMessage <-> extension storage/background. */
var fanbackArmed = false;

window.addEventListener("message", function (event) {
  if (event.source !== window) return;
  var data = event.data;
  if (!data || data.source !== "fanback") return;
  if (!fanbackArmed && data.type === "BATCH") return;
  chrome.runtime.sendMessage({ type: "EVENT", event: data });
});

chrome.runtime.onMessage.addListener(function (message) {
  if (!message || !message.type) return;
  if (message.type === "SCAN") fanbackArmed = true;
  if (message.type === "STOP") fanbackArmed = false;
  window.postMessage(
    { source: "fanback-cmd", type: message.type, mode: message.mode || "", cursor: message.cursor || "" },
    "*",
  );
});
