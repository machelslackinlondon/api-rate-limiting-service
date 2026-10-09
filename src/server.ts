import { buildApp } from './app';
import { loadConfig } from './config/config';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await buildApp({ config });
  let closing = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  await app.listen({ host: config.host, port: config.port });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
