import workerRuntime from "./worker.js";
import * as domains from "./domains/index.js";

// Sprint A orchestrator entrypoint.
// Runtime behavior remains delegated to the existing worker implementation.
export { domains };
export default workerRuntime;

