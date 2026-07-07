// A deliberately slow "remote" allow-list fetch. Synchronous so the test blocks
// on it — this is the collaborator the test SHOULD mock to run fast.
function sleepMs(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

class SlowManifestClient {
  fetchManifest() {
    sleepMs(250);
    return { allowed: ['linter', 'formatter', 'typechecker'] };
  }
}

module.exports = { SlowManifestClient };
