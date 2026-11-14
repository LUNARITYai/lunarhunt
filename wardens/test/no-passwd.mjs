// Preload (`node --import`) that makes os.homedir() throw like it does for a uid
// without a passwd entry (the CI container): unset HOME and no way to resolve it.
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";

os.homedir = () => {
  throw new Error("ERR_SYSTEM_ERROR: uv_os_homedir returned ENOENT");
};
syncBuiltinESMExports();
