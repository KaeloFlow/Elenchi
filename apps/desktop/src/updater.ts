import { autoUpdater } from "electron-updater";

/**
 * Auto-update via GitHub Releases. The feed (KaeloFlow/Elenchi) comes from the
 * `build.publish` config in package.json, which electron-builder bakes into the
 * packaged app as app-update.yml — no runtime environment variables needed.
 *
 * Only runs in packaged builds. Set ELENCHI_DISABLE_UPDATES=1 to opt out.
 * Updates download in the background, the OS shows a notification, and the
 * new version is installed when the user quits the app.
 */
export const updater = {
  initialize(isPackaged: boolean): void {
    if (!isPackaged || process.env.ELENCHI_DISABLE_UPDATES === "1") return;

    autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn("Elenchi update check failed:", error);
    });
  },
};
