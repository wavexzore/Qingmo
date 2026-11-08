// WDIO builds alias the real in-memory adapter to this module. Reaching it
// means the native Tauri adapter was not selected.
class UnavailableInThisBuild {
  constructor() {
    throw new Error("in-memory adapters are unavailable in this build");
  }
}

export { UnavailableInThisBuild as FakePlatform };
