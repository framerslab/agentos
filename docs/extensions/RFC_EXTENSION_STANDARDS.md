# RFC: AgentOS Community Extensions Standards

## Status
**Draft v1.0** - December 2024

## Summary
This RFC establishes standards for community-contributed extensions to the AgentOS ecosystem, leveraging the existing [`ExtensionManager`](https://github.com/framerslab/agentos/blob/master/src/extensions/ExtensionManager.ts) and [`ExtensionPack`](https://github.com/framerslab/agentos/blob/master/src/extensions/manifest.ts) architecture.

## Terminology
- **Extension**: A discrete unit of functionality (tool, guardrail, workflow, etc.)
- **Extension Pack**: A collection of related extensions distributed together
- **Extension Registry**: The community repository for discovering and sharing extensions

## Repository Structure

### Monorepo Layout
```
voice-chat-assistant/
├── packages/
│   ├── agentos/                    # core runtime
│   └── agentos-extensions/         # git submodule to external repo
│       ├── README.md
│       ├── CONTRIBUTING.md
│       ├── packages/               # individual extension packages
│       │   ├── ext-search/
│       │   ├── ext-weather/
│       │   └── ext-template/
│       └── registry.json           # extension discovery manifest
```

### External Repository
Repository: `github.com/framerslab/agentos-extensions`
- Community-driven with PR review process
- MIT licensed
- Automated CI/CD for publishing to npm

## Extension Package Structure

### Directory Layout
```
packages/ext-{name}/
├── src/
│   ├── index.ts           # main export
│   ├── tools/             # tool implementations
│   ├── guardrails/        # guardrail implementations
│   └── types.ts           # TypeScript definitions
├── test/
│   ├── unit/
│   └── integration/
├── docs/
│   └── README.md          # user documentation
├── examples/
│   └── basic.ts           # usage examples
├── package.json
├── tsconfig.json
├── LICENSE                # MIT required
└── manifest.json          # extension metadata
```

### Package Naming Convention
- NPM scope: `@framers/agentos-ext-{name}`
- Repository folder: `ext-{name}`
- Extension ID: `com.framers.ext.{name}`

### Manifest Format
```json
{
  "$schema": "https://agentos.sh/schemas/extension-manifest-v1.json",
  "id": "com.framers.ext.search",
  "name": "Web Search Extension",
  "version": "1.0.0",
  "description": "Adds web search capabilities to AgentOS agents",
  "author": {
    "name": "Your Name",
    "email": "email@example.com",
    "url": "https://github.com/username"
  },
  "license": "MIT",
  "keywords": ["search", "web", "research"],
  "agentosVersion": "^2.0.0",
  "categories": ["productivity", "research"],
  "repository": {
    "type": "git",
    "url": "https://github.com/framerslab/agentos-extensions"
  },
  "extensions": [
    {
      "kind": "tool",
      "id": "webSearch",
      "displayName": "Web Search",
      "description": "Search the web for information",
      "entry": "./dist/tools/webSearch.js"
    }
  ],
  "configuration": {
    "properties": {
      "search.provider": {
        "type": "string",
        "enum": ["serper", "serpapi", "brave"],
        "default": "serper",
        "description": "Search API provider"
      },
      "search.apiKey": {
        "type": "string",
        "description": "API key for search provider",
        "secret": true
      }
    }
  },
  "dependencies": {
    "axios": "^1.6.0"
  }
}
```

## Extension Implementation

### Tool Extension Template
```typescript
// src/tools/webSearch.ts
import type { 
  ITool, 
  ToolExecutionContext, 
  ToolExecutionResult,
  JSONSchemaObject 
} from '@framers/agentos';

export class WebSearchTool implements ITool {
  readonly id = 'com.framers.ext.search.webSearch';
  readonly name = 'webSearch';
  readonly displayName = 'Web Search';
  readonly description = 'Search the web for information using configured search API';
  readonly version = '1.0.0';
  
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query'
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        default: 5
      }
    },
    required: ['query']
  };
  
  readonly outputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            snippet: { type: 'string' },
            url: { type: 'string' }
          }
        }
      }
    }
  };
  
  readonly permissions = {
    requiredScopes: ['internet.access'],
    requiredCapabilities: ['web-search']
  };
  
  async execute(
    input: { query: string; maxResults?: number },
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    try {
      const config = context.configuration?.['search'] || {};
      const provider = config.provider || 'serper';
      const apiKey = config.apiKey;
      
      if (!apiKey) {
        return {
          success: false,
          error: 'Search API key not configured'
        };
      }
      
      // Implementation here...
      const results = await this.performSearch(input.query, apiKey, provider);
      
      return {
        success: true,
        output: { results }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Search failed'
      };
    }
  }
  
  private async performSearch(query: string, apiKey: string, provider: string) {
    // Provider-specific implementation
    switch(provider) {
      case 'serper':
        return this.searchWithSerper(query, apiKey);
      case 'serpapi':
        return this.searchWithSerpAPI(query, apiKey);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }
  
  // ... provider implementations
}
```

### Extension Pack Export
```typescript
// src/index.ts
import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';
import { WebSearchTool } from './tools/webSearch';
import { ResearchAggregatorTool } from './tools/researchAggregator';

export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  return {
    name: '@framers/agentos-ext-search',
    version: '1.0.0',
    descriptors: [
      {
        id: 'webSearch',
        kind: 'tool',
        payload: new WebSearchTool(),
        priority: 10,
        enableByDefault: true,
        metadata: {
          category: 'research',
          requiresApiKey: true
        },
        onActivate: async (ctx) => {
          ctx.logger?.info('Web Search tool activated');
        }
      },
      {
        id: 'researchAggregator', 
        kind: 'tool',
        payload: new ResearchAggregatorTool(),
        priority: 10,
        enableByDefault: false
      }
    ]
  };
}

export default createExtensionPack;
```

## Testing Requirements

### Unit Tests
```typescript
// test/unit/webSearch.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { WebSearchTool } from '../../src/tools/webSearch';

describe('WebSearchTool', () => {
  it('validates input schema', () => {
    const tool = new WebSearchTool();
    expect(tool.inputSchema.required).toContain('query');
  });
  
  it('handles missing API key gracefully', async () => {
    const tool = new WebSearchTool();
    const result = await tool.execute(
      { query: 'test' },
      { configuration: {} } as any
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('API key');
  });
});
```

### Integration Tests
Must test with actual AgentOS runtime:
```typescript
// test/integration/extension.spec.ts
import { AgentOS } from '@framers/agentos';
import createExtensionPack from '../../src';

describe('Search Extension Integration', () => {
  it('registers with AgentOS', async () => {
    const agentos = new AgentOS();
    const manifest = {
      packs: [{
        factory: () => createExtensionPack({ 
          manifestEntry: {} as any,
          source: { sourceName: 'test' }
        })
      }]
    };
    
    await agentos.initialize({ 
      extensionManifest: manifest,
      // ... other config
    });
    
    const tool = agentos.toolExecutor.getTool('webSearch');
    expect(tool).toBeDefined();
  });
});
```

## Documentation Standards

### Required Documentation
1. **README.md** - User-facing documentation with:
   - Installation instructions
   - Configuration guide
   - Usage examples
   - API reference
   - Troubleshooting

2. **API.md** - Technical reference:
   - Full TypeScript interfaces
   - Method signatures
   - Event descriptions
   - Error codes

3. **CHANGELOG.md** - Version history following [Keep a Changelog](https://keepachangelog.com)

### Example README Template
```markdown
# Web Search Extension for AgentOS

Enable web search capabilities for your AgentOS agents.

## Installation

\`\`\`bash
npm install @framers/agentos-ext-search
\`\`\`

## Configuration

Add to your AgentOS configuration:

\`\`\`typescript
import { createExtensionPack } from '@framers/agentos-ext-search';

const config = {
  extensionManifest: {
    packs: [{
      package: '@framers/agentos-ext-search',
      options: {
        search: {
          provider: 'serper',
          apiKey: process.env.SERPER_API_KEY
        }
      }
    }]
  }
};
\`\`\`

## Supported Providers

- **Serper** - 2,500 free queries ([Sign up](https://serper.dev))
- **SerpAPI** - 100 free/month ([Sign up](https://serpapi.com))
- **Brave** - 2,000 free/month ([Sign up](https://brave.com/search/api))

## Usage

Agents with search tools enabled can:
- "Search for latest AI news"
- "Research renewable energy"
- "Find information about quantum computing"
```

## Publishing Process

### Version Management
- Follow [Semantic Versioning](https://semver.org)
- Breaking changes require major version bump
- New features require minor version bump
- Bug fixes require patch version bump

### Release Workflow
```bash
# 1. Update version
npm version patch|minor|major

# 2. Build and test
npm run build
npm test

# 3. Publish to npm
npm publish --access public

# 4. Create GitHub release
git tag v1.0.0
git push --tags
```

### Automated CI/CD
GitHub Actions workflow for:
1. Linting and type checking
2. Unit and integration tests
3. Build verification
4. NPM publishing on release
5. Registry update

## CI/CD Infrastructure

### Free for Community Contributors

**We provide FREE GitHub Actions CI/CD for all community extensions!** This includes:

- ✅ Automated testing on Node 18 & 20
- ✅ Code coverage reporting via Codecov
- ✅ Automated npm publishing on version bump
- ✅ GitHub releases with changelogs
- ✅ Documentation generation
- ✅ Dependency updates via Dependabot
- ✅ Security scanning
- ✅ Extension validation

### Automated Workflows

#### On Pull Request
1. Extension validation (structure, naming, license)
2. Linting and type checking
3. Unit and integration tests
4. Coverage reporting
5. Security scanning

#### On Push to Master
1. Build all modified extensions
2. Run full test suite
3. Generate documentation
4. Update registry

#### On Version Bump
1. Verify tests pass
2. Build production bundle
3. Publish to npm
4. Create GitHub release
5. Update extension registry

## Community Guidelines

### Contributing Process
1. Fork `agentos-extensions` repository
2. Create feature branch: `feat/extension-name`
3. Implement extension following standards
4. Add comprehensive tests
5. Update registry.json
6. Submit PR with:
   - Description of functionality
   - Test results
   - Documentation
   - Examples

### Code Review Criteria
- [ ] Follows naming conventions
- [ ] Implements ITool interface correctly
- [ ] Includes comprehensive tests (>80% coverage)
- [ ] Documentation is complete
- [ ] No security vulnerabilities
- [ ] MIT licensed
- [ ] Semantic versioning

### Extension Categories
- **productivity** - Task automation, organization
- **research** - Information gathering, analysis
- **communication** - Messaging, notifications
- **development** - Coding, debugging tools
- **data** - Processing, transformation
- **integration** - Third-party services
- **utility** - General purpose tools

## Security Guidelines

### API Key Management
- Never hardcode API keys
- Use environment variables or secure configuration
- Mark sensitive fields with `secret: true` in manifest
- Document required permissions clearly

### Sandboxing
- Extensions run in AgentOS context
- No direct file system access unless permitted
- Network requests must be declared
- Resource limits enforced by runtime

## Migration Path

### From Hardcoded Tools
For tools currently in `backend/src/tools/`:
1. Extract to extension package
2. Implement ITool interface
3. Add manifest.json
4. Publish to npm
5. Update personas to use extension

## Future Considerations

### Extension Marketplace
- Web UI for browsing extensions
- Ratings and reviews
- Usage analytics
- Verified publisher badges

### Extension Development Kit
```bash
npx create-agentos-extension my-extension
```

### Visual Studio Code Extension
- IntelliSense for extension APIs
- Manifest validation
- Testing integration
- Publishing commands

## References
- [AgentOS Architecture](./ARCHITECTURE.md)
- [ITool Interface](../../src/core/tools/ITool.ts)
- [ExtensionManager](../../src/extensions/ExtensionManager.ts)
- [Example Extensions](https://github.com/framerslab/agentos-extensions)

## Appendix: Quick Start Template

```bash
# Clone template
git clone https://github.com/framerslab/agentos-extensions
cd packages/ext-template

# Rename and configure
mv ext-template ext-myextension
npm init

# Install dependencies
npm install

# Develop
npm run dev

# Test
npm test

# Build
npm run build

# Publish
npm publish
```

