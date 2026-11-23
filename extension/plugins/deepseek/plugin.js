BroAgentAI.registerPlugin('deepseek', {
  detectError(api) {
    const text = api.text();
    if (/usage\s+limit\s+reached/i.test(text)) {
      return { kind: 'quota', message: 'DeepSeek usage limit reached. Switch chat or wait for the quota to reset.' };
    }
    return null;
  },
});
