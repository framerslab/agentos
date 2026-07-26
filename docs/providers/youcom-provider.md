# You.com Provider Integration

The YouCom provider integrates You.com's web search and research capabilities into AgentOS, offering agents access to real-time web information, news search, and content extraction.

## Overview

Unlike traditional LLM providers, YouCom specializes in:
- **Real-time web search** with source URLs and snippets
- **News search** with timestamps and publication metadata  
- **Content extraction** from URLs
- **Research synthesis** with citations

The provider supports both keyless (free tier) and authenticated operation modes.

## Quick Start

```typescript
import { agent } from '@framers/agentos';

// Basic usage with keyless access
const researcher = agent({
  provider: 'youcom',
  instructions: 'You are a research assistant with access to current web information.',
});

const session = researcher.session('research-1');
await session.send('What are the latest developments in AI agent frameworks?');
```

## Authentication

### Keyless Mode (Default)
- **100 free searches per day per IP**
- No API key required
- Automatic rate limiting
- Perfect for development and evaluation

### Authenticated Mode  
Set your You.com API key for higher quotas and enhanced features:

```bash
export YDC_API_KEY="your_api_key_here"
```

Get your API key at [you.com/platform/api-keys](https://you.com/platform/api-keys).

Alternative environment variable (legacy support):
```bash
export YOUCOM_API_KEY="your_api_key_here"
```

### Custom Configuration

```typescript
const agent = agent({
  provider: 'youcom',
  providerConfig: {
    apiKey: 'your-key',
    searchApiUrl: 'https://api.you.com/v1/agents/search', // default
    mcpServerUrl: 'https://api.you.com/mcp', // for future MCP integration
    debug: true
  }
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
await provider.initialize({ apiKey: 'optional' });

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
      snippet: "Relevant excerpt from the page..."
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
      snippet: "Article excerpt...",
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
  if (error.message.includes('rate limit')) {
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

## Integration with AgentOS Tools

The YouCom provider exposes search capabilities through AgentOS's tool system:

```typescript
const agent = agent({
  provider: 'youcom',
  tools: ['search'], // Enables search tool access
  instructions: 'Use search when you need current information'
});
```

## MCP Server Integration (Future)

YouCom provider is designed for future integration with You.com's MCP server at `https://api.you.com/mcp`, which will provide:
- `you-search` tool for web search
- `you-contents` tool for URL content extraction  
- `you-research` tool for research synthesis

## Limitations

- **No LLM generation**: YouCom focuses on search/tools, not text generation
- **No embeddings**: Use other providers for embedding models
- **No streaming**: Search results are returned as complete responses
- **Rate limits**: Keyless tier has daily quotas (overcome with API key)

## Provider Registry

YouCom is automatically registered in AgentOS's provider system:

```typescript
// Auto-detection via environment variables
// Priority: YDC_API_KEY > YOUCOM_API_KEY

const config = {
  providers: [
    {
      providerId: 'youcom',
      enabled: true,
      config: {
        apiKey: process.env.YDC_API_KEY,
        debug: false
      }
    }
  ]
};
```

## Best Practices

1. **Use for current information**: YouCom excels at real-time web data
2. **Combine with LLM providers**: Use YouCom for search, other providers for generation  
3. **Cache results**: Avoid repeated identical searches
4. **Respect rate limits**: Monitor quota usage in production
5. **Cite sources**: Always include URLs in agent responses

## Examples

See `examples/youcom-search-example.mjs` for a complete working example demonstrating:
- Agent configuration with YouCom provider
- Multiple search query types
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