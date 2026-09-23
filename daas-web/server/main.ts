import { createApplication } from './app.ts';
import { loadConfig } from './config.ts';
import { publicError } from './safety.ts';

try {
  const config = await loadConfig();
  const app = await createApplication(config);
  app.server.listen(config.port, config.host, () => {
    console.log(`DaaS Agent 已启动：${config.origin}${config.demo ? '（演示模式：固定流程与虚构数据，无真实模型或平台调用）' : ''}`);
  });
  app.server.on('error', () => { console.error('DaaS 服务启动失败，请检查端口和网络配置。'); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { app.runtime.shutdown(); app.server.close(); });
} catch (error) { console.error(publicError(error).message); process.exitCode = 1; }
