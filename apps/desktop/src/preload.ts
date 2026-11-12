import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("elenchiDesktop", {
  version: process.versions.app,
});
