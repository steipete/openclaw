"use strict";

const err = new Error(
  "openclaw: this optional native dependency was stubbed out by the " +
    "single-file sandbox bundle build. It is only reached when a non-allowed " +
    "plugin tries to load a native module. Configure config.plugins.allow " +
    "to keep activation within the bundled 3-channel scope.",
);
err.code = "ERR_OPENCLAW_BUNDLED_OPTIONAL_DISABLED";
throw err;
