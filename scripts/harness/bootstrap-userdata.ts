/**
 * MUST be imported FIRST (before any ModMixer module), so it runs before
 * anything calls app.getPath('userData').
 *
 * A bare Electron process defaults its app name to "Electron", so userData
 * resolves to %APPDATA%\Electron — an empty dir with no auth.enc / settings.
 * Point it at the real ModMixer userData so the harness reads the user's
 * saved OpenRouter credential (decryptable cross-process via DPAPI on
 * Windows), settings, and workspace. The path comes from the runner via
 * MM_USERDATA.
 */
import { app } from 'electron';

const userData = process.env.MM_USERDATA;
if (userData) {
  app.setPath('userData', userData);
}
