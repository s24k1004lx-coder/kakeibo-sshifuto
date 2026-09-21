// PayCale 用の最小限の Service Worker
// 役割は今のところ「プッシュ通知を受け取って表示する」ことだけ。

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "PayCale", body: "通知が届きました" };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    // JSONでなければそのままテキストとして扱う
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "PayCale", {
      body: data.body || "",
      icon: "https://img.icons8.com/color/192/calculator--v1.png",
      badge: "https://img.icons8.com/color/192/calculator--v1.png"
    })
  );
});

// 通知をタップしたらアプリを開く
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});
