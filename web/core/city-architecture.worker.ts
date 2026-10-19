import { buildArchitecture, type ArchitectureReply, type ArchitectureRequest } from './building-architecture';

addEventListener('message', (event: MessageEvent<ArchitectureRequest>) => {
  const { id, feature, lod } = event.data;
  try {
    const result = buildArchitecture(feature, lod);
    const reply: ArchitectureReply = { id, result };
    postMessage(reply, { transfer: [result.bytes] });
  } catch (error) {
    const reply: ArchitectureReply = { id, error: error instanceof Error ? error.message : String(error) };
    postMessage(reply);
  }
});
