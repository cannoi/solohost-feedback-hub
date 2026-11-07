export function attachGracefulShutdown({ server, database, stopWorkers = () => {}, processObject = process, logger = console.log, errorLogger = console.error, timeoutMs = 10000 }) {
  let shuttingDown = false;
  let timedOut = false;
  let databaseClosed = false;

  function closeDatabase() {
    if (databaseClosed) return;
    databaseClosed = true;
    try { database.close(); }
    catch (closeError) {
      errorLogger(`Database close failed: ${String(closeError?.message || "unknown error").slice(0, 160)}`);
      processObject.exitCode = 1;
    }
  }

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger(`Received ${signal}; draining HTTP requests`);
    const timeout = setTimeout(() => {
      timedOut = true;
      errorLogger("Graceful shutdown timed out");
      try { server.closeAllConnections?.(); } catch {}
      closeDatabase();
      processObject.exitCode = 1;
    }, timeoutMs);
    timeout.unref?.();
    Promise.resolve().then(() => stopWorkers()).catch((error) => {
      errorLogger(`Worker shutdown failed: ${String(error?.message || "unknown error").slice(0, 160)}`);
      processObject.exitCode = 1;
    }).then(() => {
      if (timedOut) return;
      try { server.close((error) => {
        clearTimeout(timeout);
        closeDatabase();
        if (error) {
          errorLogger(`HTTP shutdown failed: ${String(error?.message || "unknown error").slice(0, 160)}`);
          processObject.exitCode = 1;
          return;
        }
        logger("graceful shutdown complete");
      }); }
      catch (error) {
        clearTimeout(timeout);
        closeDatabase();
        errorLogger(`HTTP shutdown failed: ${String(error?.message || "unknown error").slice(0, 160)}`);
        processObject.exitCode = 1;
      }
    });
  }

  processObject.once("SIGTERM", () => shutdown("SIGTERM"));
  processObject.once("SIGINT", () => shutdown("SIGINT"));
  return shutdown;
}
