BroAgentAI.registerPlugin('my-chat', {
  async prepare(api) {
    api.click('button /Dismiss/i');
    await api.sleep(200);
  },
  detectError(api) {
    const text = api.text();
    if (/usage limit reached/i.test(text)) {
      return { kind: 'quota', message: 'My Chat usage limit reached. Switch chat or wait for the quota to reset.' };
    }
    return null;
  },
});
