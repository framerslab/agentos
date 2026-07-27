# You.com Provider Integration

The YouCom provider integrates You.com's web search into AgentOS, offering access to real-time web information and news search.

## Overview

Unlike traditional LLM providers, YouCom specializes in:
- **Real-time web search** with source URLs, descriptions, and snippets
- **News search** with timestamps and publication metadata

The provider reads credentials from `YDC_API_KEY` or `YOUCOM_API_KEY`, and you can also pass an explicit `apiKey` during initialization.

## Quick Start

```typescript
import { YouComProvider } from '@framers/agentos';

const provider = new YouComProvider();
await provider.initialize();

const results = await provider.search('What are the latest developments in AI agent frameworks?', {
  count: 5,
});

for (const item of results.web ?? []) {
  console.log(item.title);
  console.log(item.url);
  console.log(item.description);
  console.log(item.snippets[0]);
}
```

## Authentication

### Environment-Based Setup
The provider reads `YDC_API_KEY` first and falls back to `YOUCOM_API_KEY` for legacy setups.

```bash
export YDC_API_KEY="your_api_key_here"
```

Get your API key at [you.com/platform/api-keys](https://you.com/platform/api-keys).

Alternative environment variable:
```bash
export YOUCOM_API_KEY="your_api_key_here"
```

### Custom Configuration

```typescript
const provider = new YouComProvider();
await provider.initialize({
  searchApiUrl: 'https://ydc-index.io/v1/search',
  mcpServerUrl: 'https://api.you.com/mcp',
  debug: true,
});
```

## Available Models

| Model ID | Description | Use Case |
|----------|-------------|----------|
| `youcom-search` | Web search with snippets | General web search queries |
| `youcom-news` | News-focused search | Recent news and current events |

## Direct Search API

Access You.com search functionality directly:

```typescript
const provider = new YouComProvider();
await provider.initialize({
  apiKey: process.env.YDC_API_KEY ?? process.env.YOUCOM_API_KEY,
});

// Web search
const results = await provider.search('TypeScript frameworks', {
  count: 5,
  type: 'web'
});

// News search  
const news = await provider.search('AI developments', {
  count: 3,
  type: 'news'
});
```

## Response Format

### Web Search Results
```typescript
{
  web: [
    {
      title: "Page title",
      url: "https://example.com",
      description: "Relevant excerpt from the page...",
      snippets: ["Relevant excerpt from the page..."]
    }
  ]
}
```

### News Search Results  
```typescript
{
  news: [
    {
      title: "Article title",
      url: "https://news.example.com/article",
      description: "Article excerpt...",
      snippets: ["Article excerpt..."],
      published_at: "2026-07-26T10:00:00Z"
    }
  ]
}
```

## Error Handling

The provider handles common error scenarios gracefully:

- **Rate limiting (429)**: Returns helpful message about API key benefits
- **Network errors**: Fail-safe with informative error messages  
- **Invalid queries**: Validation with suggestion prompts
- **Quota exceeded**: Clear indication of limits and upgrade paths

```typescript
try {
  const results = await provider.search('query');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('rate limit')) {
    console.log('Consider using an API key for higher quotas');
  }
}
```

## Health Monitoring

Check provider connectivity and configuration:

```typescript
const health = await provider.checkHealth();
console.log('Healthy:', health.isHealthy);
console.log('API Key configured:', health.details.apiKeyConfigured);
```

## AgentOS Registry

YouCom is automatically registered in AgentOS's provider system:

```typescript
import { AIModelProviderManager } from '@framers/agentos';

const manager = new AIModelProviderManager();
await manager.initialize({
  providers: [
    {
      providerId: 'youcom',
      enabled: true,
      config: {
        apiKey: process.env.YDC_API_KEY ?? process.env.YOUCOM_API_KEY,
      },
    },
  ],
});
```

## MCP Server Path

You.com's MCP surface also includes content and research tooling. This provider
keeps the search integration small and optional, but if you wire the MCP server
later the corresponding tool names are:
- `you-search` for web search
- `you-contents` for URL content extraction
- `you-research` for research synthesis

Those MCP tools are not enabled by this PR.

## Limitations

- **No LLM generation**: YouCom focuses on search/tools, not text generation
- **No embeddings**: Use other providers for embedding models
- **No streaming**: Search results are returned as complete responses
- **Rate limits**: Keyless tier has daily quotas (overcome with API key)

## Best Practices

1. **Use for current information**: YouCom excels at real-time web data
2. **Combine with LLM providers**: Use YouCom for search, other providers for generation  
3. **Cache results**: Avoid repeated identical searches
4. **Respect rate limits**: Monitor quota usage in production
5. **Cite sources**: Always include URLs in agent responses

## Examples

See `examples/youcom-search-example.mjs` for a complete working example demonstrating:
- Direct search and news search with YouComProvider
- Multiple query types
- Direct API access
- Error handling patterns
- Configuration examples

## Troubleshooting

### "Provider not initialized" 
- Ensure `initialize()` is called before use
- Check network connectivity

### "Rate limit exceeded"
- Set `YDC_API_KEY` environment variable  
- Implement request throttling
- Consider caching search results

### "Search API connectivity test failed"
- Check internet connection
- Verify You.com API endpoint accessibility
- Review firewall/proxy settings

### Integration Issues
- Confirm YouCom is registered in `AIModelProviderManager`
- Check provider configuration in AgentOS config
- Enable debug logging: `debug: true`

## Contributing

YouCom provider follows AgentOS provider standards:
- Implements full `IProvider` interface
- Comprehensive error handling
- Unit test coverage
- Documentation and examples

See [Provider Integration Guide](../contributing/new-provider.md) for details.
