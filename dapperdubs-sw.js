const CACHE_NAME = 'dapper-dubs-v1';
const ASSETS = ['./index.html', './manifest.json', './icon192.png', './icon512.png'];
const PUSH_WORKER_URL = 'https://dapper-dubs-push.choppeddubs.workers.dev';

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Activate — clean old caches + clean stale completion data
self.addEventListener('activate', e => {
  e.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
      ),
      cleanOldCompletedTasks()
    ])
  );
  self.clients.claim();
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ============================================================
// ===== IndexedDB — shared completion state (page + SW) ======
// ============================================================

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dapper-dubs-sw', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('completions')) {
        db.createObjectStore('completions', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('completed_tasks')) {
        db.createObjectStore('completed_tasks', { keyPath: 'taskId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Completion queue (for syncing BG completions to page) ---

async function storeCompletion(taskId, timestamp) {
  try {
    const db = await openDB();
    const tx = db.transaction('completions', 'readwrite');
    tx.objectStore('completions').add({ taskId, timestamp, synced: false });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) {
    console.warn('SW: Failed to store completion in IndexedDB:', e);
  }
}

// --- Completed task registry (notification guard) ---

async function markTaskCompleted(taskId) {
  try {
    const db = await openDB();
    const tx = db.transaction('completed_tasks', 'readwrite');
    tx.objectStore('completed_tasks').put({ taskId, timestamp: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) {
    console.warn('SW: Failed to mark task completed:', e);
  }
}

async function unmarkTaskCompleted(taskId) {
  try {
    const db = await openDB();
    const tx = db.transaction('completed_tasks', 'readwrite');
    tx.objectStore('completed_tasks').delete(taskId);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) {
    console.warn('SW: Failed to unmark task completed:', e);
  }
}

async function isTaskCompleted(taskId) {
  try {
    const db = await openDB();
    const tx = db.transaction('completed_tasks', 'readonly');
    const result = await new Promise((res, rej) => {
      const req = tx.objectStore('completed_tasks').get(taskId);
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    db.close();
    return result && (Date.now() - result.timestamp < 36 * 60 * 60 * 1000);
  } catch (e) {
    return false;
  }
}

async function cleanOldCompletedTasks() {
  try {
    const db = await openDB();
    const tx = db.transaction('completed_tasks', 'readwrite');
    const store = tx.objectStore('completed_tasks');
    const all = await new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const item of all) {
      if (item.timestamp < cutoff) store.delete(item.taskId);
    }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) {
    console.warn('SW: Failed to clean old completed tasks:', e);
  }
}

// --- Dismiss all visible notifications for a task ---

async function dismissNotificationsForTask(taskId) {
  try {
    const notifications = await self.registration.getNotifications();
    for (const n of notifications) {
      if (n.data?.taskId === taskId) n.close();
    }
  } catch (e) {
    console.warn('SW: Failed to dismiss notifications:', e);
  }
}

// ============================================================
// ===== Background task completion (app closed) ==============
// ============================================================

async function backgroundCompleteTask(taskId, subscription) {
  await markTaskCompleted(taskId);
  await storeCompletion(taskId, Date.now());

  if (subscription?.endpoint) {
    try {
      await fetch(PUSH_WORKER_URL + '/complete-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint, taskId })
      });
    } catch (e) {
      console.warn('SW: Failed to notify worker of completion:', e);
    }
  }

  await dismissNotificationsForTask(taskId);
}

async function getSubscription() {
  try {
    return await self.registration.pushManager.getSubscription();
  } catch (e) {
    return null;
  }
}

// ============================================================
// ===== PUSH — receive server-sent push notifications ========
// ============================================================

self.addEventListener('push', e => {
  let data = { title: 'Dapper Dubs', body: 'Time to handle your routine!' };
  try {
    if (e.data) {
      const parsed = e.data.json();
      data = { ...data, ...parsed };
    }
  } catch (err) {
    if (e.data) data.body = e.data.text();
  }

  const actions = [];
  if (data.taskId) {
    actions.push({ action: 'complete', title: 'Complete Task' });
    actions.push({ action: 'snooze', title: 'Snooze 15m' });
  }

  const options = {
    body: data.body,
    tag: data.tag || 'dapper-dubs-push',
    icon: './icon192.png',
    badge: './icon192.png',
    requireInteraction: true,
    renotify: true,
    data: { taskId: data.taskId || null, timestamp: Date.now() },
    actions
  };

  if (data.taskId) {
    e.waitUntil(
      isTaskCompleted(data.taskId).then(completed => {
        if (completed) {
          console.log(`SW: Suppressed push for completed task ${data.taskId}`);
          return;
        }
        return self.registration.showNotification(data.title, options);
      })
    );
  } else {
    e.waitUntil(self.registration.showNotification(data.title, options));
  }
});

// ============================================================
// ===== Handle notification click ============================
// ============================================================

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const action = e.action;
  const taskId = e.notification.data?.taskId;

  e.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    if (action === 'complete' && taskId) {
      const sub = await getSubscription();

      if (windowClients.length > 0) {
        for (const client of windowClients) {
          client.postMessage({ type: 'COMPLETE_TASK', taskId });
        }
        await markTaskCompleted(taskId);
        await dismissNotificationsForTask(taskId);
        return windowClients[0].focus();
      } else {
        await backgroundCompleteTask(taskId, sub);
        await self.registration.showNotification('Done!', {
          body: 'Task marked complete. Stay sharp, king.',
          tag: 'completion-confirm',
          icon: './icon192.png',
          badge: './icon192.png',
          requireInteraction: false
        });
        return;
      }
    }

    if (action === 'snooze' && taskId) {
      const snoozeMs = 15 * 60 * 1000;
      const originalTitle = e.notification.title || 'Dapper Dubs Reminder';
      await new Promise(resolve => {
        setTimeout(async () => {
          const completed = await isTaskCompleted(taskId);
          if (completed) {
            console.log(`SW: Suppressed snoozed notification for completed task ${taskId}`);
            resolve();
            return;
          }
          await self.registration.showNotification(originalTitle, {
            body: 'Snoozed reminder — time to handle this now!',
            tag: `snooze-${taskId}-${Date.now()}`,
            icon: './icon192.png',
            badge: './icon192.png',
            requireInteraction: true,
            renotify: true,
            data: { taskId, timestamp: Date.now() },
            actions: [
              { action: 'complete', title: 'Complete Task' },
              { action: 'snooze', title: 'Snooze 15m' }
            ]
          });
          resolve();
        }, snoozeMs);
      });
      return;
    }

    // Default tap — open/focus the app
    if (windowClients.length > 0) {
      return windowClients[0].focus();
    }
    return clients.openWindow('./index.html');
  })());
});

// ============================================================
// ===== Messages from page ===================================
// ============================================================

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag, data, actions } = e.data;
    const taskId = data?.taskId;

    if (taskId) {
      isTaskCompleted(taskId).then(completed => {
        if (completed) {
          console.log(`SW: Suppressed SHOW_NOTIFICATION for completed task ${taskId}`);
          return;
        }
        self.registration.showNotification(title, {
          body, tag,
          data: data || {},
          actions: actions || [],
          icon: './icon192.png',
          badge: './icon192.png',
          requireInteraction: true,
          renotify: true
        });
      });
    } else {
      self.registration.showNotification(title, {
        body, tag,
        data: data || {},
        actions: actions || [],
        icon: './icon192.png',
        badge: './icon192.png',
        requireInteraction: true,
        renotify: true
      });
    }
  }

  if (e.data && e.data.type === 'TASK_COMPLETED') {
    (async () => {
      await markTaskCompleted(e.data.taskId);
      await dismissNotificationsForTask(e.data.taskId);
    })();
  }

  if (e.data && e.data.type === 'TASK_UNCOMPLETED') {
    (async () => {
      await unmarkTaskCompleted(e.data.taskId);
    })();
  }

  if (e.data && e.data.type === 'GET_BG_COMPLETIONS') {
    (async () => {
      try {
        const db = await openDB();
        const tx = db.transaction('completions', 'readwrite');
        const store = tx.objectStore('completions');
        const all = await new Promise((res, rej) => {
          const req = store.getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = rej;
        });
        store.clear();
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
        db.close();

        if (e.source) {
          e.source.postMessage({ type: 'BG_COMPLETIONS', completions: all });
        }
      } catch (err) {
        console.warn('SW: Failed to read completions:', err);
      }
    })();
  }
});
