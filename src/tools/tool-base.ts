/**
 * Base tool interface and abstract class for all agent tools
 */

import type { Tool, ToolContext, ToolResult } from '../types/agent-types.js';

// Re-export types for convenience
export type { Tool, ToolContext, ToolResult } from '../types/agent-types.js';

/**
 * Abstract base class for all tools
 * Provides common functionality and enforces interface
 */
export abstract class BaseTool implements Tool {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly category: 'analysis' | 'porting' | 'verification' | 'refinement';

    /**
     * Execute the tool with the given context
     */
    abstract execute(context: ToolContext): Promise<ToolResult>;

    /**
     * Check if this tool can handle the given context
     * Default implementation checks task type
     */
    canHandle(context: ToolContext): boolean {
        if (!context.task) {
            return false;
        }

        const taskType = context.task.type;
        const category = this.category;

        // Map task types to categories
        const mapping: Record<string, string[]> = {
            'analysis': ['analyze'],
            'porting': ['port'],
            'verification': ['verify', 'test'],
            'refinement': ['refine'],
        };

        return mapping[category]?.includes(taskType) ?? false;
    }

    /**
     * Helper to create a successful result
     */
    protected createSuccessResult(output: any, metadata?: Record<string, any>): ToolResult {
        return {
            success: true,
            output,
            metadata,
        };
    }

    /**
     * Helper to create a failure result
     */
    protected createFailureResult(error: string, metadata?: Record<string, any>): ToolResult {
        return {
            success: false,
            error,
            metadata,
        };
    }

    /**
     * Helper to measure execution time
     */
    protected async measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
        const start = Date.now();
        const result = await fn();
        const duration = Date.now() - start;
        return { result, duration };
    }

    /**
     * Helper to extract code from markdown code blocks
     */
    protected extractCode(response: string, language?: string): string {
        // Try to extract from code block with language
        if (language) {
            const langRegex = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\\n\`\`\``, 'i');
            const match = response.match(langRegex);
            if (match) {
                return match[1].trim();
            }
        }

        // Try to extract from any code block
        const codeBlockRegex = /```[\w]*\n([\s\S]*?)\n```/;
        const match = response.match(codeBlockRegex);
        if (match) {
            return match[1].trim();
        }

        // Return as-is if no code block found
        return response.trim();
    }

    /**
     * Helper to extract JSON from response
     */
    protected extractJSON(response: string): any {
        // Try to find JSON object
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Failed to parse JSON: ${message}`);
            }
        }

        throw new Error('No JSON found in response');
    }

    /**
     * Helper to validate required context fields
     */
    protected validateContext(context: ToolContext, required: string[]): void {
        const missing = required.filter(field => !(field in context));
        if (missing.length > 0) {
            throw new Error(`Missing required context fields: ${missing.join(', ')}`);
        }
    }

    /**
     * Helper to log messages (respects verbose flag)
     */
    protected log(message: string, context?: ToolContext): void {
        if (context?.verbose) {
            console.log(`[${this.name}] ${message}`);
        }
    }

    /**
     * Helper to log errors
     */
    protected logError(message: string, error?: Error): void {
        console.error(`[${this.name}] ERROR: ${message}`);
        if (error) {
            console.error(error);
        }
    }
}

/**
 * Tool registry for managing available tools
 */
export class ToolRegistry {
    private tools: Map<string, Tool> = new Map();

    /**
     * Register a tool
     */
    register(tool: Tool): void {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool already registered: ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
    }

    /**
     * Get a tool by name
     */
    get(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    /**
     * Get all tools
     */
    getAll(): Tool[] {
        return Array.from(this.tools.values());
    }

    /**
     * Get tools by category
     */
    getByCategory(category: Tool['category']): Tool[] {
        return this.getAll().filter(tool => tool.category === category);
    }

    /**
     * Find tools that can handle the given context
     */
    findCapable(context: ToolContext): Tool[] {
        return this.getAll().filter(tool => tool.canHandle(context));
    }

    /**
     * Select the best tool for the given context
     */
    selectBest(context: ToolContext): Tool | null {
        const capable = this.findCapable(context);

        if (capable.length === 0) {
            return null;
        }

        // For now, return the first capable tool
        // In the future, could implement more sophisticated selection
        return capable[0];
    }

    /**
     * List all registered tool names
     */
    listNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * Check if a tool is registered
     */
    has(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * Unregister a tool
     */
    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    /**
     * Clear all tools
     */
    clear(): void {
        this.tools.clear();
    }

    /**
     * Get tool count
     */
    get size(): number {
        return this.tools.size;
    }
}
