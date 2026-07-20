import { bash, type SandboxFactory } from '@flue/runtime';
import { Bash } from 'just-bash';

const isolatedMemorySandbox = bash(() => new Bash());

// Keep Flue's required session environment while removing its default
// model-facing filesystem and shell tools. Repository access is available only
// through this project's three custom, bounded tools.
export const restrictedSandbox: SandboxFactory = {
  createSessionEnv: isolatedMemorySandbox.createSessionEnv.bind(
    isolatedMemorySandbox,
  ),
  tools: () => [],
};
