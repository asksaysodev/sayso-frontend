/// <reference path="./globals.d.ts" />
import type { 
  BrowserWindow as BrowserWindowType, 
  DevicePermissionHandlerHandlerDetails, 
  Tray as TrayType,
  WebContents
} from 'electron';
import type { Event } from 'electron';
import type { 
  AuthUser, 
  AudioQueueItem, 
  AudioCaptureOptions, 
  CueInsight 
} from './globals';

import { app, BrowserWindow, ipcMain, screen as electronScreen, shell, systemPreferences, globalShortcut, dialog, Tray, Menu, nativeTheme, powerMonitor } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { nativeImage } from 'electron/common';
import * as Sentry from '@sentry/electron/main';
import sentryConfig from './sentry.config';
import { WindowManager } from './utils/windowManager';
import { clearRefreshToken, loadRefreshToken, saveRefreshToken } from './utils/tokenStore';
import { resetPermissionsIfCertChanged } from './utils/permissionsMigration';
import { AuthManager } from './auth/AuthManager';
import type { AuthState } from './auth/AuthManager';

Sentry.init(sentryConfig);

const IS_STAGING = (require('../package.json') as { build_env?: string }).build_env === 'staging';

if (IS_STAGING) {
  // Give staging its own safeStorage keychain entry so it doesn't conflict
  // with production's "sayso-app Safe Storage" item (different binary, same entry name = prompt every launch)
  app.setName('sayso-app-staging');
  app.setPath('userData', path.join(app.getPath('appData'), 'sayso-app-staging'));
} else if (!app.isPackaged) {
  // Dev runs (`npm run dev`) are unpackaged and carry no build_env, so without this
  // they fall through to the default "sayso-app" userData — the SAME directory the
  // installed production app uses — and pollute its auth/permissions state (e.g.
  // writing permissions-team-id.json, which then suppresses the prod cert migration).
  // Isolate dev into its own directory. (app.isPackaged is reliable here; NODE_ENV is not.)
  app.setName('sayso-app-dev');
  app.setPath('userData', path.join(app.getPath('appData'), 'sayso-app-dev'));
}

// ─── Permissions-complete flag ────────────────────────────────────────────────
const getPermissionsCompletePath = () => path.join(app.getPath('userData'), 'permissions-complete');

function isMacOSPermissionsComplete(): boolean {
  const mic = systemPreferences.getMediaAccessStatus('microphone') === 'granted';
  // CGPreflight is accurate for the running process (screen-recording grant is bound at launch).
  const screen = !!(nativeAudio && typeof nativeAudio.checkScreenRecordingGranted === 'function'
    && nativeAudio.checkScreenRecordingGranted());
  // Live OS state is authoritative: if both are actually granted for this process, onboarding is
  // complete regardless of the flag. This self-heals the case where the flag is missing but perms
  // work — e.g. after the cert migration deletes the flag and the user re-grants + reopens. We only
  // short-circuit on live grants, so an optimistically-written flag without a real SCK grant
  // (screen === false) still routes back to /permissions.
  if (mic && screen) {
    if (!fs.existsSync(getPermissionsCompletePath())) {
      try {
        fs.writeFileSync(getPermissionsCompletePath(), '1');
      } catch (e) {
        console.warn('[Permissions] Failed to self-heal permissions-complete flag:', e);
      }
    }
    return true;
  }
  return false;
}

// Platform dispatcher: are all OS permissions required to run granted (and onboarding flag set)?
// Mirrors checkOSPermissionsGranted so main can stay platform-agnostic.
function isPermissionsComplete(): boolean {
  try {
    if (process.platform === 'darwin') return isMacOSPermissionsComplete();
    // Windows and other platforms: no permission gating yet
    return true;
  } catch {
    return false;
  }
}

interface PermissionsResult {
  granted: boolean;
  mic: boolean;
  screen: boolean;
}

async function checkMacOSPermissions(): Promise<PermissionsResult> {
  const mic = systemPreferences.getMediaAccessStatus('microphone') === 'granted';
  // Use CGPreflightScreenCaptureAccess (non-prompting) to READ status — never triggers the macOS
  // dialog. The dialog is only shown on explicit user action via requestScreenRecordingPermission.
  let screen = false;
  if (nativeAudio && typeof nativeAudio.checkScreenRecordingGranted === 'function') {
    screen = !!nativeAudio.checkScreenRecordingGranted();
  } else {
    console.warn('[Permissions] checkScreenRecordingGranted not available on nativeAudio');
  }
  return { granted: mic && screen, mic, screen };
}

async function checkOSPermissionsGranted(): Promise<PermissionsResult> {
  if (process.platform === 'darwin') return checkMacOSPermissions();
  // Windows and other platforms: no permission gating yet
  return { granted: true, mic: true, screen: true };
}

// ─── Auth: single source of truth ────────────────────────────────────────────
// Owns all token state for the app's lifetime. Renderers ask main via IPC.
export const authManager = new AuthManager();

// True when init() failed transiently at boot (offline at startup).
// The token-refreshed handler checks this to run the deferred profile/features fetch.
let startupOfflinePending = false;

function broadcastToAllWindows(channel: string, data?: unknown): void {
  BrowserWindow.getAllWindows().forEach((win: BrowserWindowType) => {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  });
}

function setAuthUser(user: AuthUser | null): void {
  global.authUser = user;
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.webContents.send('user-auth', { authUser: user });
  }
  if (global.mainWindow && !global.mainWindow.isDestroyed()) {
    global.mainWindow.webContents.send('user-auth', { authUser: user });
  }
}

// Tracks the in-flight profile fetch started on the most recent sign-in so the
// onboarding gate (splash-login-success) can await a fresh `global.authUser`
// before deciding whether to show onboarding. Without this, the renderer's
// debounced account fetch (AuthContext) races the gate — and the splash often
// closes before it lands — leaving global.authUser stale (`false`). That made
// the tray show a logged-out state and re-opened onboarding even when the
// account already had onboarding_status === 'complete'.
let authUserReady: Promise<void> = Promise.resolve();

// Fetches the full account profile into global.authUser (main's source of truth
// for subscription/onboarding state and the tray's logged-in display). Mirrors
// the silent-restore fetch at startup. Never throws — on failure the tray falls
// back to its logged-out state, same as the restore path.
async function loadAuthUserProfile(accessToken: string, email: string | undefined): Promise<void> {
  if (!email) return;
  const baseUrl = process.env.VITE_BACKEND_BASE_URL || 'http://localhost:4000';
  try {
    const res = await axios.get(`${baseUrl}/accounts/${email}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 5000,
    });
    setAuthUser(res.data.data);
    maybeReportAppVersion(baseUrl, accessToken, res.data.data);
  } catch (err) {
    console.warn('[MAIN] sign-in: profile fetch failed — tray will show logged-out state', (err as Error)?.message);
    Sentry.captureException(err);
  }
}

authManager.on('signed-in', (state: AuthState) => {
  console.log('[AuthManager] signed-in:', state.user?.email);
  global.authAccessToken = state.accessToken;
  broadcastToAllWindows('auth:state', { user: state.user, isAuthenticated: state.isAuthenticated, accessToken: state.accessToken });
  if (state.accessToken) {
    // Load the account profile into global.authUser now, so the tray shows the
    // logged-in state and the onboarding gate sees the real onboarding_status.
    authUserReady = loadAuthUserProfile(state.accessToken, state.user?.email);
    const baseUrl = process.env.VITE_BACKEND_BASE_URL || 'http://localhost:4000';
    fetchAndCacheEnabledFeatures(baseUrl, state.accessToken).catch((err) => {
      console.warn('[AuthManager] signed-in: features fetch failed', err?.message);
      Sentry.captureException(err);
    });
  }
});

authManager.on('signed-out', () => {
  console.log('[AuthManager] signed-out');
  global.authAccessToken = null;
  global.authRefreshToken = null;
  cachedEnabledFeatures = [];
  global.playbooksCache = null;
  broadcastEnabledFeatures();
  broadcastToAllWindows('auth:state', { user: null, isAuthenticated: false, accessToken: null });
  broadcastToAllWindows('auth-session-expired');   // backward-compat for unmigrated windows
  broadcastToAllWindows('auth:session-expired');
});

authManager.on('token-refreshed', async (state: AuthState) => {
  console.log('[AuthManager] token-refreshed');
  global.authAccessToken = state.accessToken;
  broadcastToAllWindows('auth:state', { user: state.user, isAuthenticated: state.isAuthenticated, accessToken: state.accessToken });
  broadcastToAllWindows('auth:token-refreshed');
  // Also broadcast old event so any remaining unmigrated axios listeners stay warm
  broadcastToAllWindows('auth-tokens-refreshed', { accessToken: state.accessToken, refreshToken: '' });
  // Keep the active audio WebSocket's token current so reconnects after a refresh
  // don't fail with an expired JWT. updateToken() stores the value and the next
  // _connect() call will embed it in the WebSocket URL query string.
  if (state.accessToken) {
    if (cueAudioStreamer) cueAudioStreamer.updateToken(state.accessToken);
    if (audioStreamer)    audioStreamer.updateToken(state.accessToken);
  }

  // Startup-offline recovery: the first successful refresh after init() failed
  // transiently at boot. Run the deferred profile/features/font-size fetch now.
  if (startupOfflinePending && state.isAuthenticated) {
    startupOfflinePending = false;
    console.log('[MAIN] Startup-offline recovery — fetching profile and features');
    const baseUrl = process.env.VITE_BACKEND_BASE_URL || 'http://localhost:4000';
    const headers = { Authorization: `Bearer ${state.accessToken}` };
    const [profileResult, fontSizeResult, featuresResult] = await Promise.allSettled([
      axios.get(`${baseUrl}/accounts/${state.user?.email}`, { headers, timeout: 5000 }),
      fetchAndCacheFontSize(baseUrl, state.accessToken!),
      fetchAndCacheEnabledFeatures(baseUrl, state.accessToken!),
    ]);
    if (profileResult.status === 'fulfilled') {
      setAuthUser(profileResult.value.data.data);
      maybeReportAppVersion(baseUrl, state.accessToken!, profileResult.value.data.data);
    } else {
      console.warn('[MAIN] Startup-offline recovery: profile fetch failed', profileResult.reason);
      Sentry.captureException(profileResult.reason);
    }
    if (fontSizeResult.status === 'rejected') {
      console.warn('[MAIN] Startup-offline recovery: font_size fetch failed', fontSizeResult.reason);
    }
    if (featuresResult.status === 'rejected') {
      console.warn('[MAIN] Startup-offline recovery: features fetch failed', featuresResult.reason);
    }
  }
});

authManager.on('session-expired', () => {
  console.log('[AuthManager] session-expired');
  global.authAccessToken = null;
  global.authRefreshToken = null;
  cachedEnabledFeatures = [];
  global.playbooksCache = null;
  broadcastEnabledFeatures();
  broadcastToAllWindows('auth:state', { user: null, isAuthenticated: false, accessToken: null });
  broadcastToAllWindows('auth-session-expired');   // backward-compat
  broadcastToAllWindows('auth:session-expired');
  // Stop WebSocket reconnect loops — there is no valid token to reconnect with
  if (cueAudioStreamer) { cueAudioStreamer.shouldReconnect = false; cueAudioStreamer.stop(false).catch(() => {}); }
  if (audioStreamer)    { audioStreamer.shouldReconnect    = false; audioStreamer.stop(false).catch(() => {}); }
  // Close secondary windows and route to the login screen so the user isn't
  // left clicking around with broken auth
  if (isCoachWindowOpen()) global.coachWindow!.close();
  if (isPlaybookWindowOpen()) global.playbookWindow!.close();
  createSplashWindow({ reason: 'session-expired' });
});

let autoUpdater: import('electron-updater').AppUpdater | null = null;

function semverGt(a: string, b: string): boolean {
  // Strip pre-release suffix (e.g. "1.2.0-beta.1" → "1.2.0") before comparing
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}

// ─── Update State Machine ─────────────────────────────────────────────────────
type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion: string | null;
  progressPercent: number;
  errorMessage: string | null;
}

let updateState: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  newVersion: null,
  progressPercent: 0,
  errorMessage: null,
};

let updateDeferralTimer: ReturnType<typeof setTimeout> | null = null;

function setUpdateState(partial: Partial<UpdateState>): void {
  updateState = { ...updateState, ...partial };
  broadcastUpdateState();
}

function broadcastUpdateState(): void {
  const targets: Array<BrowserWindowType | null | undefined> = [
    splashWindowInstance,
    trayMenuWindow,
    global.appSettingsWindow as BrowserWindowType | null,
  ];
  for (const win of targets) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:state-changed', updateState);
    }
  }
}

function isCoachSessionActive(): boolean {
  return cueAudioStreamer !== null;
}

function openSplashForUpdate(): void {
  if (splashWindowInstance && !splashWindowInstance.isDestroyed()) {
    splashWindowInstance.webContents.send('update:state-changed', updateState);
    splashWindowInstance.focus();
  } else {
    try {
      createSplashWindow();
    } catch (err) {
      Sentry.captureException(err);
    }
  }
}

function scheduleUpdateDeferralRecheck(): void {
  if (updateDeferralTimer) clearTimeout(updateDeferralTimer);
  updateDeferralTimer = setTimeout(() => {
    updateDeferralTimer = null;
    if (updateState.phase !== 'available') return;
    if (!isCoachSessionActive()) {
      openSplashForUpdate();
    } else {
      scheduleUpdateDeferralRecheck();
    }
  }, 10 * 60 * 1000);
}
// ─────────────────────────────────────────────────────────────────────────────

// Global error handler to prevent app crashes from unhandled exc eptions
// (e.g. native module failures on unsupported hardware)
process.on('uncaughtException', (error) => {
  console.error('[MAIN] Uncaught Exception:', error);
  Sentry.captureException(error);
  // Do NOT exit the process. This allows the app to stay alive
  // so the auto-updater can still run or the user can see an error UI.
});

if (app.isPackaged) {
  const { autoUpdater: updater } = require('electron-updater');
  const log = require('electron-log');

  updater.logger = log;
  updater.logger.transports.file.level = 'info';
  log.info('Auto-updater initialized');

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  if (IS_STAGING) {
    updater.allowPrerelease = true;
    updater.channel = 'staging';
  }

  updater.on('checking-for-update', () => {
    log.info('Checking for updates...');
    setUpdateState({ phase: 'checking', errorMessage: null });
  });

  updater.on('update-available', (info: { version: string }) => {
    log.info('Update available:', info.version);
    const current = app.getVersion();
    if (!semverGt(info.version, current)) {
      log.warn(`[Updater] Ignoring update to ${info.version} — not newer than current ${current}`);
      setUpdateState({ phase: 'idle', newVersion: null });
      if (splashWindowInstance && !splashWindowInstance.isDestroyed()) {
        splashWindowInstance.webContents.send('update-check-complete');
      }
      return;
    }
    setUpdateState({ phase: 'available', newVersion: info.version });

    if (isCoachSessionActive()) {
      // Don't interrupt an active call — defer splash; tray entry still shows via broadcastUpdateState
      scheduleUpdateDeferralRecheck();
    } else {
      openSplashForUpdate();
    }
  });

  updater.on('update-not-available', (info: { version: string }) => {
    log.info('Update not available. Current version:', info.version);
    setUpdateState({ phase: 'idle', newVersion: null });
    // Signal splash to stop showing the loader (no update found)
    if (splashWindowInstance && !splashWindowInstance.isDestroyed()) {
      splashWindowInstance.webContents.send('update-check-complete');
    }
  });

  updater.on('error', (err: Error) => {
    log.error('Error in auto-updater:', err);
    const OFFLINE_PATTERNS = ['ERR_INTERNET_DISCONNECTED', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN'];
    const isOffline = OFFLINE_PATTERNS.some(p => err.message.includes(p));
    if (!isOffline) Sentry.captureException(err);
    setUpdateState({
      phase: 'error',
      errorMessage: isOffline
        ? 'No internet connection. Please check your network and try again.'
        : err.message,
    });
  });

  updater.on('download-progress', (progressObj: { percent?: number; transferred?: number; total?: number; bytesPerSecond?: number }) => {
    const percent = progressObj.percent ?? 0;
    const speed = progressObj.bytesPerSecond ?? 0;
    log.info(`Download progress: ${percent.toFixed(1)}% - Speed: ${speed} bytes/sec`);
    setUpdateState({ phase: 'downloading', progressPercent: percent });
  });

  updater.on('update-downloaded', (info: { version: string }) => {
    log.info('Update downloaded:', info.version);
    setUpdateState({ phase: 'downloaded' });
    setImmediate(() => {
      try {
        app.removeAllListeners('window-all-closed');
        updater.quitAndInstall(false, true);
      } catch (err) {
        Sentry.captureException(err);
        setUpdateState({
          phase: 'error',
          errorMessage: 'Failed to install update. Please restart the app manually.',
        });
      }
    });
  });

  autoUpdater = updater;
}

// Native audio module - will be loaded after logging is set up
let nativeAudio: any = null;

// Add file logging for production
function setupLogging() {
  // Always create a debug file to see what's happening
  const debugPath = path.join(app.getPath('userData'), 'debug-startup.log');
  
  try {
    const debugInfo = {
      timestamp: new Date().toISOString(),
      appName: app.getName(),
      nodeEnv: process.env.NODE_ENV,
      userDataPath: app.getPath('userData'),
      processType: process.type
    };

    fs.writeFileSync(debugPath, JSON.stringify(debugInfo, null, 2));
  } catch (error) {
    console.error('[DEBUG] Error creating debug file:', error);
    Sentry.captureException(error);
  }
  
  // Then proceed with normal logging setup
  if (process.env.NODE_ENV === 'production') {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    const logFile = path.join(logDir, `sayso-${new Date().toISOString().split('T')[0]}.log`);
    
    // Redirect console.log to both console and file
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    
    function writeToFile(level: string, ...args: any[]) {
      const timestamp = new Date().toISOString();
      const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      ).join(' ');
      
      const logEntry = `[${timestamp}] [${level}] ${message}\n`;
      
      try {
        fs.appendFileSync(logFile, logEntry);
      } catch (err: any) {
        // Fallback to original console if file writing fails
        originalError(`Failed to write to log file: ${err.message}`);
      }
    }
    
    console.log = (...args) => {
      originalLog(...args);
      writeToFile('INFO', ...args);
    };
    
    console.error = (...args) => {
      originalError(...args);
      writeToFile('ERROR', ...args);
    };
    
    console.warn = (...args) => {
      originalWarn(...args);
      writeToFile('WARN', ...args);
    };
    
    console.log(`[MAIN] Logging to file: ${logFile}`);
  }
}

// ===== ENABLED FEATURES CACHE =====
let cachedEnabledFeatures: string[] = [];

async function fetchAndCacheEnabledFeatures(baseUrl: string, accessToken: string): Promise<void> {
  const res = await axios.get(`${baseUrl}/features/company`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 5000,
  });
  const features = res.data?.features;
  if (Array.isArray(features)) {
    cachedEnabledFeatures = features.filter((f: { enabled: boolean }) => f.enabled).map((f: { key: string }) => f.key);
    broadcastEnabledFeatures();
  }
}

function broadcastEnabledFeatures(): void {
  const payload = { enabledFeatures: cachedEnabledFeatures };
  BrowserWindow.getAllWindows().forEach((win: BrowserWindowType) => {
    if (!win.isDestroyed()) win.webContents.send('enabled-features-changed', payload);
  });
}

// ===== FONT SIZE CACHE =====
let cachedFontSize: string = 's';

const VALID_FONT_SIZES = new Set(['s', 'm', 'l']);

function applyFontSize(size: string) {
  if (!VALID_FONT_SIZES.has(size)) return;
  cachedFontSize = size;
  if (isCoachWindowOpen()) {
    global.coachWindow!.webContents.send('font-size-changed', size);
  }
  if (isPlaybookWindowOpen()) {
    global.playbookWindow!.webContents.send('font-size-changed', size);
  }
}

async function fetchAndCacheFontSize(baseUrl: string, accessToken: string): Promise<void> {
  const res = await axios.get(`${baseUrl}/sales-coach/settings`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 5000,
  });
  const size = res.data?.coachSettings?.font_size;
  if (size && VALID_FONT_SIZES.has(size)) {
    cachedFontSize = size;
  }
}

async function reportAppVersionIfChanged(baseUrl: string, accessToken: string, storedVersion: string | null | undefined): Promise<void> {
  const runningVersion = app.getVersion();
  if (runningVersion === storedVersion) return;
  const osLabel = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform;
  const osVersion = process.getSystemVersion();
  await axios.put(
    `${baseUrl}/accounts/update-account`,
    {
      updateData: {
        desktop_app_latest_version: runningVersion,
        desktop_app_os: `${osLabel} ${osVersion}`,
        desktop_app_updated_at: new Date().toISOString(),
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 5000 }
  );
}

function maybeReportAppVersion(baseUrl: string, accessToken: string, user: AuthUser | false | null): void {
  if (!app.isPackaged || IS_STAGING || !user) return;
  reportAppVersionIfChanged(baseUrl, accessToken, user.desktop_app_latest_version as string | null | undefined).catch((err) => {
    console.warn('[MAIN] Failed to report app version:', err?.message);
    Sentry.captureException(err);
  });
}

// ===== HELPER FUNCTIONS =====
function isCoachWindowOpen() {
  return global.coachWindow && !global.coachWindow.isDestroyed();
}
function isAppSettingsWindowOpen() {
  return global.appSettingsWindow && !global.appSettingsWindow.isDestroyed();
}
function isPlaybookWindowOpen() {
  return global.playbookWindow && !global.playbookWindow.isDestroyed();
}
function broadcastAppSettingsWindowState(isOpen: boolean) {
  const payload = { isOpen };
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    global.coachWindow.webContents.send('app-settings-window-state', payload);
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.webContents.send('app-settings-window-state', payload);
  }
}
function broadcastPlaybookWindowState(isOpen: boolean) {
  const payload = { isOpen };
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    global.coachWindow.webContents.send('playbook-window-state', payload);
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.webContents.send('playbook-window-state', payload);
  }
}

// ===== CUSTOM TRAY MENU WINDOW =====
let tray: TrayType | null = null;
let trayMenuWindow: BrowserWindowType | null = null;
let trayMenuShownAt = 0;
const TRAY_BLUR_GRACE_MS = 250;
let onboardingWindowInstance: BrowserWindowType | null = null;
let onboardingClosedIntentionally = false;
let isAppQuitting = false;

// Ensure isAppQuitting is set before any window close events fire, regardless
// of whether the process is terminated via Cmd+Q, SIGTERM, or SIGINT.
process.on('SIGTERM', () => { isAppQuitting = true; app.quit(); });
process.on('SIGINT',  () => { isAppQuitting = true; app.quit(); });

function sendToOnboardingWindow(channel: string) {
  if (onboardingWindowInstance && !onboardingWindowInstance.isDestroyed()) {
    onboardingWindowInstance.webContents.send(channel);
  }
}

/**
 * Creates and positions the custom tray menu window near the tray icon
 */
const TRAY_MENU_WIDTH = 230; 
function createTrayMenuWindow() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    if (trayMenuWindow.isVisible()) {
      hideTrayMenu();
    } else {
      showTrayMenu();
    }
    return;
  }

  const preloadScriptPath = path.join(__dirname, 'preload.js');
  const allowVibrancy: boolean = process.platform === 'darwin' && process.arch !== 'x64'; 

  // Create a frameless, always-on-top window
  trayMenuWindow = new BrowserWindow({
    width: TRAY_MENU_WIDTH,
    height: 172,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    vibrancy: allowVibrancy ? 'menu' : undefined,
    visualEffectState: allowVibrancy ? 'active' : undefined,
    backgroundColor: allowVibrancy ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1f2937' : '#F9FAFB'),
    webPreferences: {
      preload: preloadScriptPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const trayMenuUrl = isDev
    ? 'http://localhost:5173/tray-menu.html'
    : `file://${path.join(__dirname, '../dist/tray-menu.html')}`;

  if (trayMenuWindow) {
    trayMenuWindow.loadURL(trayMenuUrl);
    
    trayMenuWindow.on('closed', () => {
        trayMenuWindow = null;
    });

    trayMenuWindow.on('blur', () => {
        // Ignore blur events that fire during/right after show — on macOS,
        // Space transitions (opening the menu from a fullscreen Space) cause
        // focus to flicker, which would otherwise hide the menu immediately.
        if (Date.now() - trayMenuShownAt < TRAY_BLUR_GRACE_MS) return;
        hideTrayMenu();
    });
    
    if (!allowVibrancy) {
      nativeTheme.on('updated', () => {
        if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
          trayMenuWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1f2937' : '#F9FAFB');
        }
      });
    }
  }
}

/**
 * Shows the tray menu window positioned near the tray icon
 */
function showTrayMenu() {
  const reveal = () => {
    if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
    // Pin to all workspaces (incl. fullscreen) while visible so macOS doesn't
    // slide the user to the window's "home" Space. Revoked on hide.
    trayMenuWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    positionTrayMenu();
    trayMenuShownAt = Date.now();
    trayMenuWindow.show();
    trayMenuWindow.focus();
    trayMenuWindow.webContents.send('coach-window-state', {
      isOpen: isCoachWindowOpen()
    });
    trayMenuWindow.webContents.send('playbook-window-state', {
      isOpen: isPlaybookWindowOpen()
    });
    trayMenuWindow.webContents.send('enabled-features-changed', {
      enabledFeatures: cachedEnabledFeatures
    });
  };

  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) {
    createTrayMenuWindow();
    setTimeout(reveal, 100);
  } else {
    reveal();
  }
}

/**
 * Hides the tray menu window
 */
function hideTrayMenu() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.hide();
    // Revoke the all-workspaces pin set during show so the window doesn't
    // linger on other Spaces (incl. fullscreen) while hidden.
    trayMenuWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
  }
}

/**
 * Positions the tray menu window near the tray icon
 * macOS: positions below the menu bar on the right side
 */
function positionTrayMenu() {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed() || !tray) return;

  const trayBounds = tray.getBounds();
  const windowBounds = trayMenuWindow.getBounds();

  // Use cursor position to identify which display the user clicked on.
  // tray.getBounds() can return coordinates for the primary display on macOS
  // even when the tray icon was clicked on a secondary display's menu bar.
  const cursorPoint = electronScreen.getCursorScreenPoint();
  const display = electronScreen.getDisplayNearestPoint(cursorPoint);
  const workArea = display.workArea;

  let x, y;

  if (process.platform === 'darwin') {
    // Center horizontally around the cursor (where the icon was clicked),
    // and place just below this display's menu bar.
    x = Math.round(cursorPoint.x - windowBounds.width / 2);
    y = Math.round(workArea.y + 5);

    // Clamp to this display's bounds
    if (x + windowBounds.width > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - windowBounds.width - 5;
    }
    if (x < workArea.x) {
      x = workArea.x + 5;
    }
  } else if (process.platform === 'win32') {
    // Windows: Position above taskbar, aligned with tray icon
    x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
    y = Math.round(trayBounds.y - windowBounds.height - 5);
  } else {
    // Linux: Position below tray icon
    x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
    y = Math.round(trayBounds.y + trayBounds.height + 5);
  }

  trayMenuWindow.setPosition(x, y, false);
}

/**
 * Registers the tray icon and sets up click handlers
 */
function registerTrayIconMenu() {
  const trayIconFile = IS_STAGING ? 'staging-tray-icon44Template.png' : 'tray-icon44Template.png';
  const iconPath = path.join(__dirname, `../public/assets/${trayIconFile}`);

  let icon = nativeImage.createFromPath(iconPath);

  if (icon.isEmpty()) {
    console.error('Tray icon failed to load! Icon is empty.');
    Sentry.captureMessage('Tray icon failed to load - icon is empty', 'error');
    return;
  }

  icon = icon.resize({ width: 19, height: 19 });
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  if (tray) {
    tray.setToolTip(IS_STAGING ? 'Sayso Staging' : 'Sayso');

    tray.on('click', () => {
      sendToOnboardingWindow('onboarding:tray-clicked');
      if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) {
        hideTrayMenu();
      } else {
        showTrayMenu();
      }
    });

    tray.on('right-click', () => {
      if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) {
        hideTrayMenu();
      } else {
        showTrayMenu();
      }
    });
  }
}

/**
 * Updates tray menu state when coach window opens/closes
 */
function updateTrayMenu() {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.webContents.send('coach-window-state', {
      isOpen: isCoachWindowOpen()
    });
  }
}

// ===== GLOBAL SHORTCUTS =====
const shortcuts = [
  {
    // Open coach window widget
    fn: () => {
      if (global.networkState === 'reconnecting') return;
      if (!global.authUser || global.authUser?.subscription_plan_id === null) return;

      if (isCoachWindowOpen()) {
        global.coachWindow?.close();
      } else {
        createCoachWindow();
        sendToOnboardingWindow('onboarding:coach-opened');
      }
    },
    keyCombination: 'Control+S'
  },
  {
    // Toggle playbook window
    fn: () => {
      if (global.networkState === 'reconnecting') return;
      if (!global.authUser || global.authUser?.subscription_plan_id === null) return;
      if (!cachedEnabledFeatures.includes('playbooks')) return;

      if (isPlaybookWindowOpen()) {
        global.playbookWindow!.close();
      } else {
        createPlaybookWindow();
      }
    },
    keyCombination: 'Control+B'
  }
];

function setupGlobalShortcut() {
  shortcuts.forEach(({ fn, keyCombination }) => {
    globalShortcut.register(keyCombination, () => {
      fn();
    });
  })
}

function unregisterGlobalShortcuts() {
  shortcuts.forEach(({ keyCombination }) => {
    globalShortcut.unregister(keyCombination);
  })
}

// Load environment variables FIRST, before any other modules
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// Store active recording session metadata

// Store AudioStreamer instance
let audioStreamer: any = null;

// Store Cue instances (separate from regular streaming)
let cueAudioStreamer: any = null;

/** Serialize stop-cue: overlapping IPC invokes await the same teardown (no double native stop). */
let cueStopInFlight: Promise<{ success: boolean; error?: string; deduped?: boolean }> | null = null;

/** Per-session telemetry: chunks + bytes forwarded from native callbacks into AudioStreamer */
let cueCaptureStats = {
  userChunks: 0,
  prospectChunks: 0,
  userBytes: 0,
  prospectBytes: 0
};

let cueLowAudioTimer: ReturnType<typeof setTimeout> | null = null;

function clearCueLowAudioTimer() {
  if (cueLowAudioTimer) {
    clearTimeout(cueLowAudioTimer);
    cueLowAudioTimer = null;
  }
}

function scheduleCueLowAudioCheck(sessionId: string) {
  clearCueLowAudioTimer();
  cueLowAudioTimer = setTimeout(() => {
    cueLowAudioTimer = null;
    if (!cueAudioStreamer || cueAudioStreamer.sessionId !== sessionId) return;
    if (cueCaptureStats.userChunks > 0) return;
    try {
      if (global.coachWindow && !global.coachWindow.isDestroyed()) {
        global.coachWindow.webContents.send('cue-low-user-audio', { sessionId });
      }
    } catch {
      /* ignore */
    }
  }, 4000);
}

/**
 * Stop Cue mic + SCK + websocket streamer (shared by stop-cue and defensive start-cue).
 * Does not touch cueStopInFlight mutex.
 */
async function teardownCueStreamsAndNative(): Promise<void> {
  clearCueLowAudioTimer();
  if (cueAudioStreamer) {
    await cueAudioStreamer.stop(false);
    cueAudioStreamer = null;
  }
  await stopUserStreaming();
  if (nativeAudio) {
    await nativeAudio.stopSystemAudioCapture();
    nativeAudio.setStreamingCallback(null);
  }
}

/**
 * Cleanup all audio capture resources (screen capture, microphone, streams)
 * Called when coach window closes or app quits to ensure permissions are released
 */
async function cleanupAllAudioCapture() {
  if (isDev) {
    console.log('[Cleanup] Starting audio capture cleanup...');
  }
  
  try {
    if (cueStopInFlight) {
      await cueStopInFlight;
    }

    // 1. Stop user streaming (handles global.userStreamingProcess)
    await stopUserStreaming();
    
    // 2. Stop system audio capture (screen recording) via native module
    if (nativeAudio) {
      await nativeAudio.stopSystemAudioCapture();
      nativeAudio.setStreamingCallback(null);
    }
    
    // 3. Stop user full recording FFmpeg process
    if (global.userFullRecordingProcess) {
      try {
        global.userFullRecordingProcess.kill('SIGINT');
        await new Promise(resolve => setTimeout(resolve, 200));
        global.userFullRecordingProcess = null;
      } catch (error) {
        console.error('[Cleanup] Error stopping user recording process:', error);
        Sentry.captureException(error);
        global.userFullRecordingProcess = null;
      }
    }
    
    // 4. Stop user MediaRecorder
    if (global.userMediaRecorder) {
      try {
        global.userMediaRecorder.stop();
        global.userMediaRecorder = null;
      } catch (error) {
        console.error('[Cleanup] Error stopping user MediaRecorder:', error);
        Sentry.captureException(error);
        global.userMediaRecorder = null;
      }
    }
    
    // 5. Stop user audio stream tracks
    if (global.userAudioStream) {
      try {
        global.userAudioStream.getTracks().forEach(track => track.stop());
        global.userAudioStream = null;
      } catch (error) {
        console.error('[Cleanup] Error stopping user audio stream:', error);
        Sentry.captureException(error);
        global.userAudioStream = null;
      }
    }
    
    // 6. Stop prospect MediaRecorder
    if (global.mediaRecorder) {
      try {
        global.mediaRecorder.stop();
        global.mediaRecorder = null;
      } catch (error) {
        console.error('[Cleanup] Error stopping prospect MediaRecorder:', error);
        Sentry.captureException(error);
        global.mediaRecorder = null;
      }
    }
    
    // 7. Stop prospect audio stream tracks
    if (global.prospectAudioStream) {
      try {
        global.prospectAudioStream.getTracks().forEach(track => track.stop());
        global.prospectAudioStream = null;
      } catch (error) {
        console.error('[Cleanup] Error stopping prospect audio stream:', error);
        Sentry.captureException(error);
        global.prospectAudioStream = null;
      }
    }
    
    // 8. Stop legacy ScreenCaptureKit instance
    if (global.screenCapture) {
      try {
        await global.screenCapture.stopSystemAudioCapture();
        global.screenCapture = null;
      } catch (error) {
        console.error('[Cleanup] Error stopping ScreenCaptureKit:', error);
        Sentry.captureException(error);
        global.screenCapture = null;
      }
    }
    
    // 9. Stop Cue audio streamer
    if (cueAudioStreamer) {
      try {
        await cueAudioStreamer.stop(false);
        cueAudioStreamer = null;
      } catch (error) {
        console.error('[Cleanup] Error stopping cue audio streamer:', error);
        Sentry.captureException(error);
        cueAudioStreamer = null;
      }
    }
    
    // 10. Stop regular audio streamer
    if (audioStreamer) {
      try {
        await audioStreamer.stop(false);
        audioStreamer = null;
      } catch (error) {
        console.error('[Cleanup] Error stopping audio streamer:', error);
        Sentry.captureException(error);
        audioStreamer = null;
      }
    }
    
    // Clear file path globals
    global.userRecordingFile = null;
    global.prospectRecordingFile = null;
    global.userActualStartMs = null;
    
    if (isDev) {
      console.log('[Cleanup] All audio capture cleaned up');
    }
  } catch (error) {
    console.error('[Cleanup] Error during audio cleanup:', error);
    Sentry.captureException(error);
  }
}

// Get streaming status
ipcMain.handle('get-streaming-status', async () => {
  if (!audioStreamer) {
    return { isStreaming: false };
  }
  return {
    isStreaming: audioStreamer.isStreamingActive(),
    userState: audioStreamer.getUserState(),
    prospectState: audioStreamer.getProspectState(),
    sessionId: audioStreamer.sessionId
  };
});

// Start Cue (handles 2 audio websockets: user + prospect)
ipcMain.handle('start-cue', async (event: Electron.IpcMainInvokeEvent, { sessionId, token }: { sessionId: string, token: string }) => {
  try {
    
    if (!token) {
      throw new Error('Token is required');
    }

    if (!sessionId) {
      throw new Error('SessionId is required');
    }

    if (!nativeAudio) {
      throw new Error('Native audio module not loaded. Please wait for app initialization.');
    }

    const permsCheck = await checkOSPermissionsGranted();
    if (!permsCheck.granted) {
      console.warn('[Cue] OS permissions not granted — mic:', permsCheck.mic, 'screen:', permsCheck.screen);
      // Surface the splash window; PostAuthRedirect sees permissions are incomplete and routes to /permissions.
      createSplashWindow();
      return { success: false, error: 'permissions_denied', mic: permsCheck.mic, screen: permsCheck.screen };
    }

    if (cueStopInFlight) {
      await cueStopInFlight;
    }

    let systemCaptureActive = false;
    let micCaptureActive = false;
    try {
      if (typeof nativeAudio.isSystemAudioCaptureActive === 'function') {
        systemCaptureActive = !!(await nativeAudio.isSystemAudioCaptureActive());
      }
      if (typeof nativeAudio.isMicrophoneCaptureActive === 'function') {
        micCaptureActive = !!(await nativeAudio.isMicrophoneCaptureActive());
      }
    } catch (probeErr) {
      console.warn('[Cue] Could not probe native capture state:', probeErr);
    }

    if (cueAudioStreamer || systemCaptureActive || micCaptureActive) {
      console.warn('[Cue] Guard: leftover streamer or native capture — running teardown before start', {
        hadStreamer: !!cueAudioStreamer,
        systemCaptureActive,
        micCaptureActive
      });
      await teardownCueStreamsAndNative();
    }

    cueCaptureStats = { userChunks: 0, prospectChunks: 0, userBytes: 0, prospectBytes: 0 };

    // Create AudioStreamer for 2 audio websockets (user + prospect)
    cueAudioStreamer = new AudioStreamer({
      sessionId: sessionId, // Use provided sessionId from backend
      onUserConnected: () => {
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('cue-status', { user: 'connected' });
          }
        } catch (error) {
          console.error('[Cue] Error sending user connected status:', error);
        }
      },
      onProspectConnected: () => {
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('cue-status', { prospect: 'connected' });
          }
        } catch (error) {
          console.error('[Cue] Error sending prospect connected status:', error);
        }
      },
      onError: (stream: string, error: Error) => {
        console.error(`[Cue] ${stream} stream error:`, error);
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('cue-error', { stream, error: error.message });
          }
        } catch (err) {
          console.error('[Cue] Error sending error status:', err);
        }
      },
      onMessage: (message: any) => {
        try {
          // Forward insight messages to renderer process
          if (message && message.type === 'insight' && message.data) {
            // Forward to coach window if it exists
            if (global.coachWindow && !global.coachWindow.isDestroyed()) {
              global.coachWindow.webContents.send('cue-insight', message.data);
            }
          }

          if (message && message.type === 'smart_capture' && message.data) {
            if (global.coachWindow && !global.coachWindow.isDestroyed()) {
              global.coachWindow.webContents.send('cue-smart-capture', message.data);
            }
          }

          if (message && message.type === 'auto_stop') {
            if (global.coachWindow && !global.coachWindow.isDestroyed()) {
              global.coachWindow.webContents.send('cue-auto-stop');
              
              if (process.platform === 'darwin') {
                app.setBadgeCount(app.getBadgeCount() + 1);
                if (app.dock) {
                  app.dock.bounce('critical');
                }
              }
            } 
          }
        } catch (error) {
          console.error('[Cue] Error handling message:', error);
        }
      }
    });

    // Start audio streaming (2 websockets)
    await cueAudioStreamer.start(token);

    // Set up audio capture callbacks (streaming only - no file saving)
    const cueUserStreamingCallback = (buffer: Buffer, format: unknown) => {
      if (cueAudioStreamer) {
        cueCaptureStats.userChunks += 1;
        cueCaptureStats.userBytes += buffer?.length ?? 0;
        cueAudioStreamer.addUserAudio(buffer, format);
      }
    };
    await startUserStreaming({ streamingCallback: cueUserStreamingCallback });
    await ensureCueUserMicDeliversJsChunks(sessionId, cueUserStreamingCallback);

    if (!nativeAudio) {
      throw new Error('Native audio module not loaded. Please wait for app initialization.');
    }

    if (typeof nativeAudio.startProspectStreaming !== 'function') {
      throw new Error('startProspectStreaming method not available. Native module may need to be rebuilt.');
    }

    await nativeAudio.startProspectStreaming({
      streamingCallback: (buffer: Buffer, format: string) => {
        if (cueAudioStreamer) {
          cueCaptureStats.prospectChunks += 1;
          cueCaptureStats.prospectBytes += buffer?.length ?? 0;
          cueAudioStreamer.addProspectAudio(buffer, format);
        }
      }
    });

    scheduleCueLowAudioCheck(sessionId);

    if (isDev) {
      console.log('[Cue] Started session', sessionId, '— stats reset; low-audio check in 4s if no user chunks');
    }

    sendToOnboardingWindow('onboarding:session-started');
    return {
      success: true,
      sessionId: sessionId
    };
  } catch (error: any) {
    console.error('[MAIN] Error starting Cue:', error);
    Sentry.captureException(error);
    clearCueLowAudioTimer();
    try {
      await teardownCueStreamsAndNative();
    } catch (teardownErr: any) {
      console.error('[Cue] Error tearing down after failed start:', teardownErr);
      cueAudioStreamer = null;
    }
    return { success: false, error: error.message };
  }
});

// Stop Cue (closes all websockets)
ipcMain.handle('stop-cue', async (_event: Electron.IpcMainInvokeEvent) => {
  if (cueStopInFlight) {
    const result = await cueStopInFlight;
    return { ...result, deduped: true };
  }

  const stopWork = (async (): Promise<{ success: boolean; error?: string }> => {
    const statsAtStop = { ...cueCaptureStats };
    try {
      await teardownCueStreamsAndNative();
      sendToOnboardingWindow('onboarding:session-stopped');
      console.log(
        `[Cue] Session teardown complete — capture stats: userChunks=${statsAtStop.userChunks} prospectChunks=${statsAtStop.prospectChunks} userBytes=${statsAtStop.userBytes} prospectBytes=${statsAtStop.prospectBytes}`
      );
      cueCaptureStats = { userChunks: 0, prospectChunks: 0, userBytes: 0, prospectBytes: 0 };
      return { success: true };
    } catch (error: any) {
      console.error('[MAIN] Error stopping Cue:', error);
      Sentry.captureException(error);
      cueAudioStreamer = null;
      cueCaptureStats = { userChunks: 0, prospectChunks: 0, userBytes: 0, prospectBytes: 0 };
      return { success: false, error: error.message };
    } finally {
      cueStopInFlight = null;
    }
  })();

  cueStopInFlight = stopWork;
  return stopWork;
});


// Function to load environment variables
function loadEnvironmentVariables() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
    return;
  }

  const basePaths = [
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '../.env'),
  ];
  for (const basePath of basePaths) {
    if (fs.existsSync(basePath)) {
      require('dotenv').config({ path: basePath });
      break;
    }
  }

  const envFile = IS_STAGING ? '.env.staging' : '.env.production';
  const possiblePaths = [
    path.resolve(__dirname, envFile),
    path.resolve(__dirname, `../${envFile}`),
    path.resolve(__dirname, `../dist/${envFile}`),
  ];

  let loaded = false;
  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath, override: true });
      loaded = true;
      break;
    }
  }

  if (!loaded) {
    console.warn(`[MAIN] ${envFile} not found in any expected location`);
  }
}

// Load environment variables
loadEnvironmentVariables();

// Now require other modules that depend on environment variables
const wav = require('wav');
const NodeFormData = require('form-data');
const axios = require('axios');
const { 
  stopUserStreaming,
  startUserStreaming
} = require('./recorder');

const CUE_MIC_JS_WARMUP_MS = 500;
const CUE_MIC_JS_RESTART_WAIT_MS = 700;

async function waitForCueUserChunks(sessionId: string, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (cueCaptureStats.userChunks > 0) return true;
    if (!cueAudioStreamer || cueAudioStreamer.sessionId !== sessionId) return false;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return cueCaptureStats.userChunks > 0;
}

/** If Node never receives mic buffers after native start, stop/start mic once (belt-and-suspenders). */
async function ensureCueUserMicDeliversJsChunks(
  sessionId: string,
  streamingCallback: (buffer: Buffer, format: unknown) => void
): Promise<void> {
  if (await waitForCueUserChunks(sessionId, CUE_MIC_JS_WARMUP_MS)) return;
  if (!cueAudioStreamer || cueAudioStreamer.sessionId !== sessionId) return;
  console.warn('[Cue] No user chunks on JS side after native mic start — restarting user streaming once', {
    sessionId,
  });
  await stopUserStreaming();
  if (!cueAudioStreamer || cueAudioStreamer.sessionId !== sessionId) return;
  await startUserStreaming({ streamingCallback });
  await waitForCueUserChunks(sessionId, CUE_MIC_JS_RESTART_WAIT_MS);
}

const audioQueue = require('./audioQueue');
const { AudioStreamer } = require('./streaming/audioStreamer');
// Add command line switches for better camera support
app.commandLine.appendSwitch('enable-features', 'WebRTC,MediaDevices,MediaStream');
app.commandLine.appendSwitch('enable-media-stream');
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('allow-running-insecure-content');
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');

// <<< Disable hardware acceleration >>>
// This can fix GPU process crashes on some systems
// app.disableHardwareAcceleration();
app.setAsDefaultProtocolClient('sayso');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Prefer Electron's packaging flag to detect development vs production
const isDev = !app.isPackaged;

// Keep track of window instances
let splashWindowInstance: BrowserWindowType | null = null;

// --- Splash Window (Auth / Loading Screen) ---
const createSplashWindow = (opts: { logout?: boolean; reason?: 'session-expired' } | boolean = {}) => {
  // Support legacy boolean call sites (createSplashWindow(true))
  const { logout = false, reason } = typeof opts === 'boolean' ? { logout: opts, reason: undefined } : opts;

  if (splashWindowInstance && !splashWindowInstance.isDestroyed()) {
    if (reason) splashWindowInstance.webContents.send('splash:show-reason', reason);
    splashWindowInstance.focus();
    return;
  }

  const preloadScriptPath = path.join(__dirname, 'preload.js');

  const splashWindow = new BrowserWindow({
    show: false,
    width: 380,
    height: 560,
    center: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: preloadScriptPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  splashWindowInstance = splashWindow;

  const params = new URLSearchParams();
  if (logout) params.set('logout', 'true');
  if (reason) params.set('reason', reason);
  const query = params.toString() ? `?${params.toString()}` : '';
  const splashUrl = isDev
    ? `http://localhost:5173/splash-window.html${query}`
    : `file://${path.join(__dirname, '../dist/splash-window.html')}${query}`;

  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
  });

  splashWindow.loadURL(splashUrl);

  if (isDev) {
    splashWindow.webContents.openDevTools();
  }

  splashWindow.on('closed', () => {
    splashWindowInstance = null;
  });
};

// Handler for opening URLs externally
ipcMain.on('open-external', (event: Electron.IpcMainInvokeEvent, url: string) => {
  try {
    shell.openExternal(url);

    // If it's a Slack OAuth URL, send reset-to-home
    if (url.includes('slack/auth')) {
      BrowserWindow.getAllWindows().forEach((win: BrowserWindowType) => {
        win.webContents.send('reset-to-home', { source: 'open-external-ipc', service: 'slack' });
      });
    }
  } catch (error) {
    console.error('[MAIN] [Electron][open-external] Error opening URL externally:', error);
    Sentry.captureException(error);
  }
});

// --- Permissions Handlers ---
// Check current mic + screen status (non-interactive)
ipcMain.handle('permissions-check', async () => {
  try {
    const result = await checkOSPermissionsGranted();
    if (isDev) console.log('[Permissions] check:', result);
    return { mic: result.mic, screen: result.screen };
  } catch (e: any) {
    console.error('[MAIN] [Permissions] Error checking permissions:', e);
    Sentry.captureException(e);
    return { mic: false, screen: false, error: e.message };
  }
});

// Request microphone permission only (never triggers app restart)
ipcMain.handle('permissions-request-mic', async () => {
  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone');
    if (micStatus === 'granted') return { mic: true, action: 'already-granted' };
    if (micStatus === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return { mic: granted, action: 'asked' };
    }
    // denied / restricted → open Microphone privacy pane directly
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    return { mic: false, action: 'open-settings' };
  } catch (e: any) {
    console.error('[MAIN] [Permissions] Error requesting mic:', e);
    Sentry.captureException(e);
    return { mic: false, action: 'error', error: e.message };
  }
});

// Non-destructive poll: did the user grant screen recording?
ipcMain.handle('permissions-check-screen', async () => {
  try {
    const result = await checkOSPermissionsGranted();
    return result.screen;
  } catch {
    return false;
  }
});

// Prompt macOS to surface the Screen Recording row in System Settings (fire-and-forget)
ipcMain.handle('permissions-request-screen', () => {
  if (!nativeAudio || typeof nativeAudio.requestScreenRecordingPermission !== 'function') return;
  try { nativeAudio.requestScreenRecordingPermission(); } catch { /* ignore */ }
});

// Open Screen Recording privacy pane directly
ipcMain.handle('permissions-open-screen-settings', async () => {
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  } catch (e: any) {
    console.warn('[MAIN] [Permissions] Could not open Screen Recording settings:', e?.message || e);
  }
});

// Write permissions-complete flag then relaunch. Only relaunch if the write succeeded —
// otherwise the next boot would route back to permissions (potential loop).
ipcMain.handle('permissions-complete', () => {
  try {
    fs.writeFileSync(getPermissionsCompletePath(), '1');
    console.log('[Permissions] permissions-complete flag written');
  } catch (e: any) {
    console.error('[MAIN] [Permissions] Failed to write permissions-complete flag:', e);
    Sentry.captureException(e);
    return { error: e.message };
  }
  app.relaunch();
  app.quit();
});

// Returns whether the permissions-complete flag is set (for renderer routing)
ipcMain.handle('permissions-get-flag', () => isPermissionsComplete());

// --- Audio Queue Event Handlers ---
audioQueue.on('failed', (item: AudioQueueItem) => {
  console.error(`[Audio Queue] Failed to process audio chunk after ${item.retries} retries: ${item.filePath} (${item.speaker})`);
  Sentry.captureMessage(`Audio queue failed: ${item.filePath} (${item.speaker}) after ${item.retries} retries`, 'error');
});

// Add IPC handler for getting queue status
ipcMain.handle('get-audio-queue-status', () => {
  return audioQueue.getStatus();
});

// Add IPC handler for reloading the page
ipcMain.handle('reload-page', () => {
  if (isDev) {
    console.log('[MAIN] Reloading page...');
  }
  return { status: "Page reloaded" };
});

// Add a simple test handler to verify IPC is working
ipcMain.handle('test-simple', () => {
  return { success: true, message: 'Simple test handler works!' };
});

// Native Audio Module IPC Handlers moved to app.whenReady() after module loads

// Handle protocol activation (when app is opened via sayso:// URL)
app.on('open-url', (event: Event, url: string) => {
  if (isDev) {
    console.log('[Electron] open-url event:', url);
    console.log('Protocol URL received:', url);
  }
  event.preventDefault();
  
  const urlObj = new URL(url);

  if (urlObj.hostname === 'launch-coach') {
    if (!isCoachWindowOpen()) {
      createCoachWindow();
    } else {
      global.coachWindow?.focus();
    }
  }
});

// Handle second instance (when app is already running and opened via protocol)
app.on('second-instance', (event: Event, commandLine: string[], workingDirectory: string) => {
  if (isDev) {
    console.log('Second instance detected, command line:', commandLine);
  }
  
  // Check if there's a protocol URL in the command line
  const protocolUrl = commandLine.find(arg => arg.startsWith('sayso://'));
  if (protocolUrl) {
    // Trigger the same handling as open-url
    app.emit('open-url', { preventDefault: () => {} }, protocolUrl);
  }
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  setupLogging();
  resetPermissionsIfCertChanged();

  // Run auto-updater check FIRST, before any potential native module crashes
  if (autoUpdater) {
    // Check immediately (with small delay to ensure network is ready)
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        console.error('Failed to check for updates:', err);
        Sentry.captureException(err);
      });
    }, 1000); // 1 second delay
    
    // Check every hour
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(err => {
        console.error('Failed to check for updates:', err);
        Sentry.captureException(err);
      });
    }, 60 * 60 * 1000);
  }

  app.on('browser-window-focus', () => {
    if (process.platform === 'darwin') {
      app.setBadgeCount(0);
    }
  });
  
  // Load native audio module AFTER logging is set up
  try {
    nativeAudio = require('./audio').default;
  } catch (error) {
    Sentry.captureException(error);
  }

  // Register IPC handlers safely (even if module failed to load)
  // This prevents "No handler registered" errors in the renderer
  
  // Initialize native audio module
  ipcMain.handle('native-audio-initialize', async () => {
    if (!nativeAudio) return { success: false, error: 'Native audio module not loaded' };
    try {
      await nativeAudio.initialize();
      return { success: true };
    } catch (error: any) {
      console.error('[MAIN] Failed to initialize native audio:', error);
      Sentry.captureException(error);
      return { success: false, error: error.message };
    }
  });

  // List output devices
  ipcMain.handle('native-audio-list-devices', async () => {
    if (!nativeAudio) return { success: false, error: 'Native audio module not loaded' };
    try {
      const devices = await nativeAudio.listOutputDevices();
      return { success: true, devices };
    } catch (error: any) {
      console.error('[MAIN] Failed to list devices:', error);
      Sentry.captureException(error);
      return { success: false, error: error.message };
    }
  });

  // Create multi-output device
  ipcMain.handle('native-audio-create-device', async (event: Electron.IpcMainInvokeEvent, { name, subDevices }: { name: string, subDevices: string[] }) => {
    if (!nativeAudio) return { success: false, error: 'Native audio module not loaded' };
    try {
      const deviceId = await nativeAudio.createMultiOutputDevice(name, subDevices);
      return { success: true, deviceId };
    } catch (error: any) {
      console.error('[MAIN] Failed to create device:', error);
      Sentry.captureException(error);
      return { success: false, error: error.message };
    }
  });

  // Delete multi-output device
  ipcMain.handle('native-audio-delete-device', async (event: Electron.IpcMainInvokeEvent, { deviceId }: { deviceId: string }) => {
    if (!nativeAudio) return { success: false, error: 'Native audio module not loaded' };
    try {
      const result = await nativeAudio.deleteMultiOutputDevice(deviceId);
      return { success: result };
    } catch (error: any) {
      console.error('[MAIN] Failed to delete device:', error);
      Sentry.captureException(error);
      return { success: false, error: error.message };
    }
  });

  // Request screen recording permission
  ipcMain.handle('native-audio-request-permission', async (): Promise<{ success: boolean, error?: string }> => {
    if (!nativeAudio) return { success: false, error: 'Native audio module not loaded' };
    try {
      const result = await nativeAudio.requestScreenRecordingPermission();
      return { success: result };
    } catch (error: any) {
      console.error('[MAIN] Failed to request permission:', error);
      Sentry.captureException(error);
      return { success: false, error: error.message };
    }
  });

  // Start system audio capture
  ipcMain.handle('native-audio-start-capture', async (event: Electron.IpcMainInvokeEvent, options: AudioCaptureOptions = {}) => {
    if (!nativeAudio) return { success: false, error: 'Native audio module not loaded' };
    try {
      return await nativeAudio.startSystemAudioCapture(options);
    } catch (error: any) {
      console.error('[MAIN] Failed to start capture:', error);
      Sentry.captureException(error);
      return { success: false, error: error.message };
    }
  });

  // Stop system audio capture
  ipcMain.handle('native-audio-stop-capture', async () => {
    if (!nativeAudio) return { success: false, error: 'Native audio module not loaded', filePath: null };
    try {
      const result = await nativeAudio.stopSystemAudioCapture();
      // Result is now {success, filePath}
      return result;
    } catch (error: any) {
      console.error('[MAIN] Failed to stop capture:', error);
      Sentry.captureException(error);
      return { success: false, error: error.message, filePath: null };
    }
  });

  // Check if system audio capture is active
  ipcMain.handle('native-audio-is-capturing', async () => {
    if (!nativeAudio) return { success: true, isCapturing: false };
    try {
      const result = await nativeAudio.isSystemAudioCaptureActive();
      return { success: true, isCapturing: result };
    } catch (error: any) {
      console.error('[MAIN] Failed to check capture status:', error);
      Sentry.captureException(error);
      return { success: false, error: error.message };
    }
  });
  
  // Always attempt silent auth via AuthManager first.
  // init() reads the persisted refresh token, exchanges it for a fresh access
  // token, and schedules the proactive refresh timer. If it fails or there is
  // no stored token it returns cleanly and we fall through to the splash.
  await authManager.init();

  // Re-validate auth on system wake and screen unlock so the first API call
  // after a sleep/lock cycle never races a half-connected network.
  powerMonitor.on('resume', () => {
    console.log('[PowerMonitor] System resumed — forcing token refresh');
    if (global.networkState === 'reconnecting') return;
    authManager.forceRefresh().catch((err) => {
      console.warn('[PowerMonitor] Force refresh after resume failed:', err?.message);
    });
  });

  powerMonitor.on('unlock-screen', () => {
    console.log('[PowerMonitor] Screen unlocked — forcing token refresh');
    if (global.networkState === 'reconnecting') return;
    authManager.forceRefresh().catch((err) => {
      console.warn('[PowerMonitor] Force refresh after screen unlock failed:', err?.message);
    });
  });

  const authState = authManager.getState();
  if (authState.isAuthenticated) {
    if (!isPermissionsComplete()) {
      // Token restored but permissions flow was never completed — show splash.
      // PostAuthRedirect will see the user is authenticated and route to /permissions.
      console.log('[MAIN] Authenticated but permissions-complete flag missing — showing splash for permissions');
      createSplashWindow();
    } else {
      const baseUrl = process.env.VITE_BACKEND_BASE_URL || 'http://localhost:4000';
      const headers = { Authorization: `Bearer ${authState.accessToken}` };

      // Fetch profile, font size, and enabled features in parallel before any window opens.
      const [profileResult, fontSizeResult, featuresResult] = await Promise.allSettled([
        axios.get(`${baseUrl}/accounts/${authState.user?.email}`, { headers, timeout: 5000 }),
        fetchAndCacheFontSize(baseUrl, authState.accessToken!),
        fetchAndCacheEnabledFeatures(baseUrl, authState.accessToken!),
      ]);

      if (profileResult.status === 'fulfilled') {
        global.authUser = profileResult.value.data.data;
      } else {
        console.warn('[MAIN] Silent auth succeeded but profile fetch failed — tray will show logged-out state', profileResult.reason);
        Sentry.captureException(profileResult.reason);
      }

      if (fontSizeResult.status === 'rejected') {
        console.warn('[MAIN] Silent auth: font_size fetch failed — falling back to default S', fontSizeResult.reason);
        Sentry.captureException(fontSizeResult.reason);
      }

      if (featuresResult.status === 'rejected') {
        console.warn('[MAIN] Silent auth: features fetch failed — no features enabled by default', featuresResult.reason);
        Sentry.captureException(featuresResult.reason);
      }

      maybeReportAppVersion(baseUrl, authState.accessToken!, global.authUser);

      // Open onboarding directly if not yet complete — no splash shown.
      const onboardingStatus = (global.authUser || undefined)?.onboarding_status;
      if (onboardingStatus !== 'complete' && onboardingStatus !== 'dismissed') {
        console.log('[MAIN] Permissions complete but onboarding not done — opening onboarding window');
        createOnboardingWindow();
      }
    }
  } else if (authManager.isNetworkRetryPending()) {
    // Offline at startup — session exists but network was down during init().
    // Silent: no splash, tray boots in disabled state. Pause auth retries until
    // the renderer reports 'online'; the token-refreshed handler then runs the
    // deferred profile/features fetch.
    global.networkState = 'reconnecting';
    startupOfflinePending = true;
    authManager.pauseRefresh();
    console.log('[MAIN] Started offline — silent tray mode, awaiting network recovery');
  } else {
    createSplashWindow();
  }
  registerTrayIconMenu();
  setupGlobalShortcut();

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplashWindow();
      setupGlobalShortcut();
    } else if (splashWindowInstance && !splashWindowInstance.isDestroyed()) {
      splashWindowInstance.restore();
      splashWindowInstance.focus();
    }
  });
});

// Cleanup audio capture before app quits
app.on('before-quit', async (event: Event) => {
  isAppQuitting = true;
  if (isDev) {
    console.log('App quitting - cleaning up audio capture...');
  }

  // Force cleanup of all audio capture before quitting
  await cleanupAllAudioCapture();
  unregisterGlobalShortcuts();
});

// Modify window-all-closed to NOT quit if dashboard is meant to be main interface
app.on('window-all-closed', () => {
  // Standard macOS behavior: quit only if platform is not darwin
  if (process.platform !== 'darwin') {
    app.quit();
  }

  // If you want the app to quit when the dashboard closes even on macOS,
  // you would add app.quit() here.
});

let lastLeaveUrl: string | null = null;
let lastLeaveUrlTime = 0;
let isProcessingPostCall = false;

// Intercept navigation in ALL windows
app.on('web-contents-created', (event: Event, contents: WebContents) => {
  contents.on('will-navigate', (event: Event, url: string) => {
    if (url.includes('post-call')) {
      const now = Date.now();
      if ((url === lastLeaveUrl && now - lastLeaveUrlTime < 3000) || isProcessingPostCall) {
        event.preventDefault();
        return;
      }

      isProcessingPostCall = true;
      lastLeaveUrl = url;
      lastLeaveUrlTime = now;

      setTimeout(() => {
        isProcessingPostCall = false;
      }, 3000);

      event.preventDefault();
      shell.openExternal(url);
      const urlObj = new URL(url);
      const params = new URLSearchParams(urlObj.search);
      const meetingId = params.get('meetingId');
      const prospectId = params.get('prospectId');
      const sessionId = params.get('sessionId');
      BrowserWindow.getAllWindows().forEach((win: BrowserWindowType) => {
        win.webContents.send('reset-to-home', { meetingId, prospectId, sessionId });
      });
    }
  });

  contents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (isDev) {
      console.log('[Electron][setWindowOpenHandler] Attempt to open URL:', url);
    }
    if (url.includes('post-call')) {
      const now = Date.now();
      // Enhanced duplicate prevention
      if ((url === lastLeaveUrl && now - lastLeaveUrlTime < 3000) || isProcessingPostCall) {
        if (isDev) {
          console.log('[Electron][DEBUG] Skipping duplicate post-call open in setWindowOpenHandler:', url);
        }
        return { action: 'deny' };
      }
      
      isProcessingPostCall = true;
      lastLeaveUrl = url;
      lastLeaveUrlTime = now;
      
      // Reset processing flag after a delay
      setTimeout(() => {
        isProcessingPostCall = false;
      }, 3000);
      
      shell.openExternal(url);
      // Extract meetingId and prospectId from query parameters
      const urlObj = new URL(url);
      const params = new URLSearchParams(urlObj.search);
      const meetingId = params.get('meetingId');
      const prospectId = params.get('prospectId');
      const sessionId = params.get('sessionId'); // Added sessionId extraction
      if (isDev) {
        console.log('[Electron][setWindowOpenHandler] Extracted params:', { meetingId, prospectId, sessionId });
      }
      BrowserWindow.getAllWindows().forEach((win: BrowserWindowType) => {
        if (isDev) {
          console.log('[Electron][setWindowOpenHandler] Sending reset-to-home to window:', win.id, { meetingId, prospectId, sessionId });
        }
        win.webContents.send('reset-to-home', { meetingId, prospectId, sessionId });
      });
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  contents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details: Electron.OnBeforeRequestListenerDetails, callback: (response: { cancel?: boolean; redirectURL?: string }) => void) => {
    callback({});
  });
});


// Authenticated User
global.authUser = false;
/**
 * Handler for getting user auth state
 * Sends current authentication status to requesting window
 */
ipcMain.on('get-user-auth', (event: Electron.IpcMainInvokeEvent) => {
  event.sender.send('user-auth', {
    authUser: global.authUser
  });
});

ipcMain.handle('get-launch-at-login', () => {
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('set-launch-at-login', (_event: Electron.IpcMainInvokeEvent, enabled: boolean) => {
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
});

ipcMain.handle('auth:sign-in', async (_event, { email, password }: { email: string; password: string }) => {
  return authManager.signIn(email, password);
});

ipcMain.handle('auth:verify-mfa', async (_event, { factorId, code }: { factorId: string; code: string }) => {
  return authManager.verifyMFA(factorId, code);
});

ipcMain.handle('auth:sign-out', async () => {
  await authManager.signOut();
});

/**
 * Returns a valid access token, proactively refreshing if within 60 s of expiry.
 * All windows call this instead of caching a token themselves.
 */
ipcMain.handle('auth:get-token', async () => {
  return authManager.getAccessToken();
});

/**
 * Forces an immediate token refresh, bypassing the 60-second proactive window.
 * Returns a discriminated result so the renderer can distinguish permanent
 * session expiry (invalid_grant) from a transient network failure — without
 * relying on IPC error serialisation which strips typed error fields.
 */
ipcMain.handle('auth:force-refresh-token', async () => {
  try {
    const token = await authManager.forceRefresh();
    if (token === null) return { ok: false, kind: 'invalid_grant' } as const;
    return { ok: true, token } as const;
  } catch {
    return { ok: false, kind: 'transient' } as const;
  }
});

ipcMain.handle('auth:get-state', () => {
  return authManager.getState();
});

// ─── Network state (renderer-driven) ────────────────────────────────────────
// Renderers report online/offline via OS events (window.addEventListener).
// Main mirrors the state globally and broadcasts so all windows stay in sync.
global.networkState = 'online';

ipcMain.on('network:report-status', (_event, status: 'online' | 'offline') => {
  const next = status === 'offline' ? 'reconnecting' : 'online';
  if (global.networkState === next) return;
  console.log('[Network] state changed:', next);
  global.networkState = next;
  broadcastToAllWindows('network:state-changed', next);

  if (next === 'reconnecting') {
    // OS says we're offline — pause both the proactive refresh timer and any
    // pending backoff retry. forceRefresh() on the 'online' event lifts the pause.
    authManager.pauseRefresh();
  } else {
    // OS says we're back online — trigger one immediate refresh instead of
    // waiting for the next scheduled tick.
    authManager.forceRefresh().catch((err) => {
      console.warn('[Network] forceRefresh on reconnect failed:', err?.message);
    });
  }
});

ipcMain.handle('network:get-state', () => global.networkState);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handler for updating user auth state
 */
ipcMain.on('update-user-auth', (_event: Electron.IpcMainInvokeEvent, { userAuthenticated }: { userAuthenticated: AuthUser | null }) => {
  setAuthUser(userAuthenticated);
})
// Handle for opening Coach settings window
ipcMain.on('open-app-settings-window', () => {
    createAppSettingsWindow();
})
ipcMain.on('close-app-settings-window', () => {
    if (global.appSettingsWindow && !global.appSettingsWindow.isDestroyed()) {
        global.appSettingsWindow.close();
        global.appSettingsWindow = null;
    } else {
        global.appSettingsWindow = null;
    }
})

ipcMain.on('app-settings:session-expired-redirect', () => {
    createSplashWindow({ reason: 'session-expired' });
    if (global.appSettingsWindow && !global.appSettingsWindow.isDestroyed()) {
        global.appSettingsWindow.close();
        global.appSettingsWindow = null;
    } else {
        global.appSettingsWindow = null;
    }
})
ipcMain.on('get-app-settings-window-state', (event: Electron.IpcMainInvokeEvent) => {
    event.sender.send('app-settings-window-state', {
        isOpen: isAppSettingsWindowOpen()
    })
})
ipcMain.handle('get-app-settings-window-open-state', () => {
    return isAppSettingsWindowOpen();
})

// Handler for opening coach window — checks mic permission first; if missing, opens splash for permissions flow
ipcMain.on('open-coach-window', () => {
  if (global.networkState === 'reconnecting') return;
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    createSplashWindow();
    return;
  }
  createCoachWindow();
  sendToOnboardingWindow('onboarding:coach-opened');
});
ipcMain.on('close-coach-window', () => {
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    global.coachWindow.close();
  }
  global.coachWindow = null;
});
// Handler for getting coach window state
ipcMain.on('get-coach-window-state', (event: Electron.IpcMainInvokeEvent) => {
  event.sender.send('coach-window-state', {
    isOpen: isCoachWindowOpen()
  });
});
// Handler for getting coach window state (async version for invoke)
ipcMain.handle('get-coach-window-open-state', () => {
  return isCoachWindowOpen();
});

ipcMain.on('get-enabled-features', (event: Electron.IpcMainInvokeEvent) => {
  event.sender.send('enabled-features-changed', { enabledFeatures: cachedEnabledFeatures });
});

// ─── Update IPC handlers ──────────────────────────────────────────────────────
ipcMain.handle('update:get-state', () => updateState);

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.on('update:start-download', () => {
  if (global.networkState === 'reconnecting') return;
  if (!autoUpdater || updateState.phase !== 'available') return;

  // Close coach window before downloading
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    global.coachWindow.close();
    global.coachWindow = null;
  }

  autoUpdater.downloadUpdate().catch((err: Error) => {
    console.error('[Updater] Download failed:', err);
    Sentry.captureException(err);
    setUpdateState({ phase: 'error', errorMessage: err.message });
  });
});

ipcMain.on('update:dismiss', () => {
  // State intentionally stays 'available' — tray entry persists so user can update later
});

ipcMain.on('update:check-for-updates', () => {
  if (updateState.phase === 'downloading' || updateState.phase === 'downloaded') return;

  // Flip to 'checking' immediately so the UI reflects the click without depending
  // on autoUpdater's 'checking-for-update' event timing (which can race against
  // 'update-not-available' on fast networks).
  setUpdateState({ phase: 'checking', errorMessage: null });

  if (!autoUpdater) {
    // Dev mode: no real auto-updater is wired up (only initialized when app.isPackaged).
    // Flip back to idle after a short delay so the loading UX is testable locally.
    setTimeout(() => setUpdateState({ phase: 'idle' }), 1500);
    return;
  }

  autoUpdater.checkForUpdates().catch((err: Error) => {
    console.error('[Updater] Check failed:', err);
    Sentry.captureException(err);
    setUpdateState({ phase: 'error', errorMessage: err.message });
  });
});

ipcMain.on('app-settings:open-update-tab', () => {
  if (global.networkState === 'reconnecting') return;
  createAppSettingsWindow('software-update');
});
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.on('set-font-size', (_event, size: string) => {
  applyFontSize(size);
});

ipcMain.on('open-onboarding-window', () => {
  if (splashWindowInstance && !splashWindowInstance.isDestroyed()) {
    console.log('[MAIN] open-onboarding-window: blocked — splash still open');
    return;
  }
  createOnboardingWindow();
});

ipcMain.on('close-onboarding-window', (_event) => {
  onboardingClosedIntentionally = true;
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.on('complete-onboarding', (_event) => {
  onboardingClosedIntentionally = true;
  const win = BrowserWindow.fromWebContents(_event.sender);
  if (win && !win.isDestroyed()) win.close();
});

// Handler for the splash window to signal successful login — closes splash, then opens onboarding if needed
ipcMain.on('splash-login-success', async () => {
  // Wait for the sign-in profile fetch so the gate reads a fresh
  // onboarding_status rather than a stale `false` from before login.
  await authUserReady;
  const status = (global.authUser || undefined)?.onboarding_status;
  const shouldOpenOnboarding = status !== 'complete' && status !== 'dismissed';

  if (splashWindowInstance && !splashWindowInstance.isDestroyed()) {
    splashWindowInstance.once('closed', () => {
      if (shouldOpenOnboarding) {
        createOnboardingWindow();
      }
    });
    splashWindowInstance.close();
  } else if (shouldOpenOnboarding) {
    createOnboardingWindow();
  }
});

// Handler for showing the splash window from the tray menu (e.g. Log In)
ipcMain.on('tray-show-window', () => {
  if (!splashWindowInstance || splashWindowInstance.isDestroyed()) {
    createSplashWindow();
  } else {
    if (splashWindowInstance.isMinimized()) splashWindowInstance.restore();
    splashWindowInstance.show();
    splashWindowInstance.focus();
  }
});

// Handler for triggering logout from the tray menu — opens splash window with sign-out flag
ipcMain.on('tray-logout', () => {
  hideTrayMenu();
  clearRefreshToken();
  if (!splashWindowInstance || splashWindowInstance.isDestroyed()) {
    createSplashWindow({ logout: true });
  } else {
    const logoutUrl = isDev
      ? 'http://localhost:5173/splash-window.html?logout=true'
      : `file://${path.join(__dirname, '../dist/splash-window.html')}?logout=true`;
    if (splashWindowInstance.isMinimized()) splashWindowInstance.restore();
    splashWindowInstance.show();
    splashWindowInstance.focus();
    splashWindowInstance.loadURL(logoutUrl);
  }
});

// Handler for resizing the tray menu window (e.g. when items are shown/hidden)
ipcMain.on('set-tray-menu-height', (_event: Electron.IpcMainEvent, height: number) => {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.setSize(TRAY_MENU_WIDTH, height, false);
    positionTrayMenu();
  }
});

// Handler for quitting the app
ipcMain.on('quit-app', () => {
  app.quit();
});

// --- Coach Settings Window ---
const createOnboardingWindow = (tab?: string) => {
  if (onboardingWindowInstance && !onboardingWindowInstance.isDestroyed()) {
    onboardingWindowInstance.focus();
    return;
  }

  if (onboardingWindowInstance && onboardingWindowInstance.isDestroyed()) {
    onboardingWindowInstance = null;
  }

  onboardingClosedIntentionally = false;

  const preloadScriptPath = path.join(__dirname, 'preload.js');
  const onboardingWindow = new BrowserWindow({
    width: 720,
    height: 560,
    titleBarStyle: 'hiddenInset',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
	backgroundColor: '#2a3f5f',
	roundedCorners: true,
    webPreferences: {
      preload: preloadScriptPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const onboardingUrl = isDev
    ? 'http://localhost:5173/onboarding-window.html'
    : `file://${path.join(__dirname, '../dist/onboarding-window.html')}`;

  onboardingWindow.loadURL(onboardingUrl);

  onboardingWindowInstance = onboardingWindow;

  onboardingWindow.on('close', async (e) => {
    console.log('[onboarding] close event fired — intentionally:', onboardingClosedIntentionally, '| isAppQuitting:', isAppQuitting);
    if (!onboardingClosedIntentionally && !isAppQuitting) {
      e.preventDefault();
      await Promise.race([
        new Promise<void>(resolve => {
          ipcMain.once('onboarding:remind-later-ack', () => resolve());
          onboardingWindow.webContents.send('onboarding:set-remind-later');
        }),
        new Promise<void>(resolve => setTimeout(resolve, 500)),
      ]);
      onboardingClosedIntentionally = true;
      onboardingWindow.close();
      return;
    }
    onboardingClosedIntentionally = false;
  });

  onboardingWindow.on('closed', () => { onboardingWindowInstance = null; });

  if (isDev) {
    onboardingWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

const createAppSettingsWindow = (tab?: string) => {
    if (global.appSettingsWindow && !global.appSettingsWindow.isDestroyed()) {
        if (isDev) {
            console.log('Coach window already exists and is not destroyed, focusing...');
        }
        global.appSettingsWindow.focus();
        if (tab) {
            global.appSettingsWindow.webContents.send('app-settings:navigate-to-update');
        }
        return;
    }

    if (global.appSettingsWindow && global.appSettingsWindow.isDestroyed()) {
        global.appSettingsWindow = null;
    }

    const preloadScriptPath = path.join(__dirname, 'preload.js');
    const windowConfig = WindowManager.getAppSettingsWindowConfig();
    const appSettingsWindow = new BrowserWindow({
        ...windowConfig,
        icon: path.join(__dirname, '../public/assets/icon.icns'),
        titleBarStyle: 'hiddenInset',
        titleBarOverlay: {
          color: '#02192f',
          symbolColor: '#FFF',
          height: 30,
        },
        webPreferences: {
            preload: preloadScriptPath,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            enableBlinkFeatures: 'MediaDevices,MediaStream,WebRTC',
            allowRunningInsecureContent: false,
            experimentalFeatures: false
        },
    });

    global.appSettingsWindow = appSettingsWindow;

    const tabParam = tab ? `?tab=${tab}` : '';
    const appSettingsUrl = isDev
      ? `http://localhost:5173/app-settings-window.html${tabParam}`
      : `file://${path.join(__dirname, '../dist/app-settings-window.html')}${tabParam}`;

    appSettingsWindow.loadURL(appSettingsUrl).catch((err: Error) => {
        Sentry.captureException(err);
    });
    broadcastAppSettingsWindowState(true);

    appSettingsWindow.on('closed', () => {
        global.appSettingsWindow = null;
        broadcastAppSettingsWindowState(false);
    })
}

// --- Coach Window (Sales Coach Interface) ---
const createCoachWindow = () => {
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    if (isDev) {
      console.log('Coach window already exists and is not destroyed, returning...');
    }
    return;
  }
  
  if (global.coachWindow && global.coachWindow.isDestroyed()) {
    global.coachWindow = null;
  }
  
  const preloadScriptPath = path.join(__dirname, 'preload.js');
  
  const windowConfig = WindowManager.getCoachWindowConfig();
  
  const coachWindow = new BrowserWindow({
    ...windowConfig,
    icon: path.join(__dirname, '../public/assets/icon.icns'),
    webPreferences: {
      preload: preloadScriptPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      enableBlinkFeatures: 'MediaDevices,MediaStream,WebRTC',
      // permissions: ['media', 'microphone'], 'permissions' does not exist in type 'WebPreferences'.
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    },
  });

  global.coachWindow = coachWindow;

  // dev vs prod URL for the coach window (use the HTML that bootstraps src/coachWindow/index.jsx)
  const coachUrl = isDev
    ? `http://localhost:5173/coach-window.html?fontSize=${cachedFontSize}`
    : `file://${path.join(__dirname, '../dist/coach-window.html')}?fontSize=${cachedFontSize}`;

  coachWindow.loadURL(coachUrl);
  
  if (isDev) {
    // coachWindow.webContents.openDevTools();
  }

  coachWindow.on('closed', async () => {
    if (isDev) {
      console.log('Coach window closed event fired, cleaning up reference');
    }

    // Force cleanup of all audio capture when coach window closes
    await cleanupAllAudioCapture();

    global.coachWindow = null;

    updateTrayMenu();
  });

  if (isDev) {
    console.log('Coach window created successfully at position:', { x: windowConfig.x, y: windowConfig.y });
  }

  updateTrayMenu();
};

// Update the resize handler to use WindowManager
ipcMain.on('resize-coach-window', (event: Electron.IpcMainInvokeEvent, width: number, height: number) => {
  if (global.coachWindow) {
    WindowManager.resizeCoachWindow(global.coachWindow, width, height);
  }
});

ipcMain.handle('get-coach-work-area-bottom', () => {
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    const { workArea } = electronScreen.getDisplayMatching(global.coachWindow.getBounds());
    return workArea.y + workArea.height;
  }
  return null;
});

// Handler for manual window dragging
ipcMain.handle('get-window-position', () => {
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    return global.coachWindow.getPosition();
  }
  return [0, 0];
});

ipcMain.on('set-window-position', (event: Electron.IpcMainInvokeEvent, x: number, y: number) => {
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    global.coachWindow.setPosition(Math.round(x), Math.round(y));
  }
});

// Handler for demo insights from AdminPanel - forwards to coach window
ipcMain.on('demo-insight', (event: Electron.IpcMainInvokeEvent, insightData: CueInsight) => {
  if (isDev) {
    console.log('[MAIN] Received demo-insight:', insightData);
  }

  // Forward to coach window if it exists and is not destroyed
  if (global.coachWindow && !global.coachWindow.isDestroyed()) {
    global.coachWindow.webContents.send('cue-insight', insightData);
    if (isDev) {
      console.log('[MAIN] Demo insight forwarded to coach window');
    }
  } else {
    if (isDev) {
      console.warn('[MAIN] Coach window not available, cannot forward demo insight');
    }
  }
});

// --- Playbook Window ---
const createPlaybookWindow = () => {
  if (global.playbookWindow && !global.playbookWindow.isDestroyed()) {
    return;
  }

  if (global.playbookWindow && global.playbookWindow.isDestroyed()) {
    global.playbookWindow = null;
  }

  const preloadScriptPath = path.join(__dirname, 'preload.js');
  const coachBounds = isCoachWindowOpen() ? global.coachWindow!.getBounds() : undefined;
  const windowConfig = WindowManager.getPlaybookWindowConfig(coachBounds);

  const playbookWindow = new BrowserWindow({
    ...windowConfig,
    icon: path.join(__dirname, '../public/assets/icon.icns'),
    webPreferences: {
      preload: preloadScriptPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  });

  global.playbookWindow = playbookWindow;

  const playbookUrl = isDev
    ? `http://localhost:5173/playbook-window.html?fontSize=${cachedFontSize}`
    : `file://${path.join(__dirname, '../dist/playbook-window.html')}?fontSize=${cachedFontSize}`;

  playbookWindow.loadURL(playbookUrl);
  broadcastPlaybookWindowState(true);

  playbookWindow.on('closed', () => {
    global.playbookWindow = null;
    broadcastPlaybookWindowState(false);
  });
};

ipcMain.on('open-playbook-window', () => {
  if (global.networkState === 'reconnecting') return;
  createPlaybookWindow();
});

ipcMain.on('close-playbook-window', () => {
  if (isPlaybookWindowOpen()) {
    global.playbookWindow!.close();
  }
});

ipcMain.on('get-playbook-window-state', (event: Electron.IpcMainInvokeEvent) => {
  event.sender.send('playbook-window-state', { isOpen: isPlaybookWindowOpen() });
});

ipcMain.handle('get-playbook-window-position', () => {
  if (isPlaybookWindowOpen()) {
    return global.playbookWindow!.getPosition();
  }
  return [0, 0];
});

ipcMain.on('set-playbook-window-position', (_event: Electron.IpcMainInvokeEvent, x: number, y: number) => {
  if (isPlaybookWindowOpen()) {
    global.playbookWindow!.setPosition(Math.round(x), Math.round(y));
  }
});

// --- Playbooks data cache (prewarmed by coach window, consumed by playbook window) ---
ipcMain.on('set-playbooks-cache', (_event, payload: { playbooks: unknown[] | null; error: string | null }) => {
  global.playbooksCache = payload;
  if (isPlaybookWindowOpen()) {
    global.playbookWindow!.webContents.send('playbooks-updated', payload);
  }
});

ipcMain.handle('get-playbooks-cache', () => {
  return global.playbooksCache ?? { playbooks: null, error: null };
});
