import type {
  ActiveExtensionDescriptor,
  ExtensionDescriptor,
  ExtensionLifecycleContext,
  ExtensionKind,
} from './types';

/**
 * Internal representation of a descriptor stack for a given id.
 */
interface DescriptorStackEntry<TPayload> {
  descriptors: ActiveExtensionDescriptor<TPayload>[];
  nextStackIndex: number;
  active?: ActiveExtensionDescriptor<TPayload>;
}

/**
 * Maintains layered stacks of descriptors for a particular extension kind.
 * New registrations push onto the stack, allowing later descriptors to
 * override earlier ones while maintaining history for fallbacks or debugging.
 */
export class ExtensionRegistry<TPayload = unknown> {
  private readonly stacks: Map<string, DescriptorStackEntry<TPayload>> = new Map();
  private readonly registerListeners: Array<
    (descriptor: ActiveExtensionDescriptor<TPayload>) => void
  > = [];

  constructor(private readonly kind: ExtensionKind) {}

  /**
   * Calls `listener` after every successful `register`, whoever made it: a
   * direct registration through `ToolExecutor`, or an extension pack
   * registering a descriptor. Returns a function that removes the listener.
   */
  public onRegister(
    listener: (descriptor: ActiveExtensionDescriptor<TPayload>) => void,
  ): () => void {
    this.registerListeners.push(listener);
    return () => {
      const index = this.registerListeners.indexOf(listener);
      if (index >= 0) {
        this.registerListeners.splice(index, 1);
      }
    };
  }

  /**
   * Registers a descriptor, making it the active entry for its id.
   */
  public async register(
    descriptor: ExtensionDescriptor<TPayload>,
    context?: ExtensionLifecycleContext,
  ): Promise<void> {
    const stack = this.getOrCreateStack(descriptor.id);
    const resolvedPriority = descriptor.priority ?? 0;
    const prevActive = stack.active ?? this.computeActive(stack);
    const activeDescriptor: ActiveExtensionDescriptor<TPayload> = {
      ...descriptor,
      resolvedPriority,
      stackIndex: stack.nextStackIndex++,
    };

    stack.descriptors.push(activeDescriptor);

    const nextActive = this.computeActive(stack);
    if (prevActive !== nextActive) {
      await prevActive?.onDeactivate?.(context ?? {});
      await nextActive?.onActivate?.(context ?? {});
    } else if (!prevActive && nextActive) {
      // First descriptor registered in this stack.
      await nextActive.onActivate?.(context ?? {});
    }

    // Read the stack again: a registration under the same id that completed
    // while the hooks above were awaited may have pushed a newer descriptor,
    // which must stay active.
    stack.active = this.computeActive(stack);

    for (const listener of [...this.registerListeners]) {
      try {
        listener(activeDescriptor);
      } catch (error) {
        // A listener's failure must not fail the registration it observes.
        console.warn('[ExtensionRegistry] a registration listener threw:', error);
      }
    }
  }

  /**
   * Removes the active descriptor for an id. If older descriptors exist in the
   * stack, they become active again.
   */
  public async unregister(id: string, context?: ExtensionLifecycleContext): Promise<boolean> {
    const stack = this.stacks.get(id);
    if (!stack || stack.descriptors.length === 0) {
      return false;
    }

    const prevActive = stack.active ?? this.computeActive(stack);
    if (!prevActive) {
      // No active descriptor, but the stack has descriptors; treat as best-effort.
      const last = stack.descriptors.pop();
      if (last) {
        await last.onDeactivate?.(context ?? {});
      }
    } else {
      const idx = stack.descriptors.findIndex((d) => d.stackIndex === prevActive.stackIndex);
      if (idx >= 0) {
        stack.descriptors.splice(idx, 1);
      }
      await prevActive.onDeactivate?.(context ?? {});
    }

    if (stack.descriptors.length === 0) {
      this.stacks.delete(id);
      return true;
    }

    const nextActive = this.computeActive(stack);
    if (nextActive) {
      await nextActive.onActivate?.(context ?? {});
    }
    stack.active = nextActive;
    return true;
  }

  /**
   * Returns the active descriptor for the provided id.
   */
  public getActive(id: string): ActiveExtensionDescriptor<TPayload> | undefined {
    const stack = this.stacks.get(id);
    return stack?.active ?? (stack ? this.computeActive(stack) : undefined);
  }

  /**
   * Lists all currently active descriptors for this registry.
   */
  public listActive(): ActiveExtensionDescriptor<TPayload>[] {
    const result: ActiveExtensionDescriptor<TPayload>[] = [];
    for (const entry of this.stacks.values()) {
      const active = entry.active ?? this.computeActive(entry);
      if (active) {
        entry.active = active;
        result.push(active);
      }
    }
    return result;
  }

  /**
   * Returns the full stack history for a descriptor id.
   */
  public listHistory(id: string): ActiveExtensionDescriptor<TPayload>[] {
    const stack = this.stacks.get(id);
    if (!stack) {
      return [];
    }
    // History is ordered by insertion (stackIndex ascending) for debuggability.
    return [...stack.descriptors].sort((a, b) => a.stackIndex - b.stackIndex);
  }

  /**
   * Clears all stacks, calling deactivate hooks for active descriptors.
   */
  public async clear(context?: ExtensionLifecycleContext): Promise<void> {
    for (const [id] of this.stacks) {
      await this.removeStack(id, context);
    }
    this.stacks.clear();
  }

  private getOrCreateStack(id: string): DescriptorStackEntry<TPayload> {
    const existing = this.stacks.get(id);
    if (existing) {
      return existing;
    }
    const entry: DescriptorStackEntry<TPayload> = { descriptors: [], nextStackIndex: 0 };
    this.stacks.set(id, entry);
    return entry;
  }

  private async removeStack(id: string, context?: ExtensionLifecycleContext): Promise<void> {
    const stack = this.stacks.get(id);
    if (!stack) {
      return;
    }
    const active = stack.active ?? this.computeActive(stack);
    if (active) {
      await active.onDeactivate?.(context ?? {});
    }
    this.stacks.delete(id);
  }

  private computeActive(
    stack: DescriptorStackEntry<TPayload>,
  ): ActiveExtensionDescriptor<TPayload> | undefined {
    let active: ActiveExtensionDescriptor<TPayload> | undefined;
    for (const descriptor of stack.descriptors) {
      if (!active) {
        active = descriptor;
        continue;
      }
      if (descriptor.resolvedPriority > active.resolvedPriority) {
        active = descriptor;
        continue;
      }
      if (
        descriptor.resolvedPriority === active.resolvedPriority &&
        descriptor.stackIndex > active.stackIndex
      ) {
        active = descriptor;
      }
    }
    return active;
  }
}
