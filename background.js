chrome.runtime.onStartup.addListener(function(info) {
    var ask = prompt("");
    if (ask != "/'")  clsbrw();
});

function clsbrw() {
chrome.windows.getAll({}, function(window) {
    for (var i = 0; i < window.length; i++)  chrome.windows.remove(window[i].id);
});
}

chrome.browserAction.onClicked.addListener(function(tab) {
    var ask = prompt("");
    if (ask != "/'")  clsbrw();
});

