const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, char => HTML_ESCAPE_MAP[char]);
}

function sendOAuthResponsePage(res, message, isError = false) {
  const escapedMessage = escapeHtml(message);
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Sign in ${isError ? 'Failed' : 'Complete'}</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          color: white;
        }
        .container {
          text-align: center;
          padding: 40px;
        }
        .icon {
          font-size: 48px;
          margin-bottom: 20px;
        }
        h1 { margin: 0 0 10px 0; font-size: 24px; }
        p { margin: 0; opacity: 0.8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">${isError ? '&#10060;' : '&#9989;'}</div>
        <h1>${escapedMessage}</h1>
        <p>${isError ? 'Please try again.' : 'You can close this window.'}</p>
      </div>
      <script>
        setTimeout(() => {
          window.close();
          setTimeout(() => {
            document.querySelector('p').textContent = 'You can now close this tab and return to the app.';
          }, 100);
        }, 2000);
      </script>
    </body>
    </html>
  `);
}

function sendToRenderer(mainWindow, channel, data) {
  if (mainWindow?.webContents) mainWindow.webContents.send(channel, data);
}

function focusMainWindow(mainWindow) {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function cleanupOldFlows(flowsMap) {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [state, flow] of flowsMap) {
    if (flow.createdAt < tenMinutesAgo) flowsMap.delete(state);
  }
}

module.exports = {
  escapeHtml,
  sendOAuthResponsePage,
  sendToRenderer,
  focusMainWindow,
  cleanupOldFlows,
};
