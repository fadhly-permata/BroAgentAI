// Dummy provider fixture for BrowserAgent
// This file represents a plugin that can be loaded by the extension.

export const providerInfo = {
  id: "dummy-provider",
  name: "Dummy Provider",
  version: "0.1.0",
  description: "A dummy provider for testing plugin extensibility",
  permissions: {
    hostPermissions: ["https://api.dummy-provider.example.com/*"]
  }
};

export function initialize() {
  console.log("Dummy provider initialized");
}
