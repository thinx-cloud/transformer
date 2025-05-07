// Mock implementation of isolated-vm for testing
class MockIsolate {
  constructor() {
    // Mock constructor
  }
  
  createContextSync() {
    return {
      global: {
        setSync: (name, value) => {
          // Mock setSync
        },
        derefInto: () => {
          return {};
        }
      }
    };
  }
  
  compileScriptSync(code) {
    return {
      runSync: () => {
        // Simulate running the code - for test purposes we directly execute the transformer function
        try {
          // Extract the transformer function from the code
          const fnMatch = code.match(/transformer\s*=\s*function\s*\([^)]*\)\s*{[^}]*}/);
          if (fnMatch) {
            // Find the callback to rtn
            const rtnMatch = code.match(/rtn\(([^)]*)\)/);
            if (rtnMatch) {
              return "mocked result";
            }
          }
        } catch (e) {
          console.error("Mock execution error:", e);
        }
      }
    };
  }
}

module.exports = {
  Isolate: MockIsolate
};