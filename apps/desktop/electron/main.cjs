cd ~/projects/voice-party

mkdir -p apps/desktop/electron

cat > apps/desktop/electron/main.cjs <<'EOF'
const { app, BrowserWindow } = require("electron");

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: { contextIsolation: true }
  });

  win.loadURL("http://127.0.0.1:5173");
}

app.whenReady().then(() => {
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
EOF
