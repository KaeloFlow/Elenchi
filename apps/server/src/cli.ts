import { startServer } from "./server.js";

startServer()
  .then((server) => {
    // eslint-disable-next-line no-console
    console.log(`Elenchi server listening at ${server.url}`);
    // eslint-disable-next-line no-console
    console.log(`Data directory: ${server.dataDir}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to start Elenchi server:", err);
    process.exit(1);
  });
