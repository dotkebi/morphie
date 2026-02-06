/**
 * Tool Manager - Registers and manages all agent tools
 */

import { ToolRegistry, type Tool } from './tool-base.js';
import { OllamaClient } from '../llm/ollama.js';
import { DeepAnalyzer } from './analysis/deep-analyzer.js';
import { FilePorter } from './porting/file-porter.js';
import { SyntaxChecker } from './verification/syntax-checker.js';
import { CodeReviewer } from './refinement/code-reviewer.js';
import type { ToolContext, ToolResult } from '../types/agent-types.js';

export class ToolManager {
    private registry: ToolRegistry;
    private llm: OllamaClient;

    constructor(llm: OllamaClient) {
        this.llm = llm;
        this.registry = new ToolRegistry();
        this.registerDefaultTools();
    }

    /**
     * Register all default tools
     */
    private registerDefaultTools(): void {
        // Analysis tools
        this.registry.register(new DeepAnalyzer());

        // Porting tools
        this.registry.register(new FilePorter(this.llm));

        // Verification tools
        this.registry.register(new SyntaxChecker());

        // Refinement tools
        this.registry.register(new CodeReviewer(this.llm));
    }

    /**
     * Get the underlying registry
     */
    getRegistry(): ToolRegistry {
        return this.registry;
    }

    /**
     * Get a tool by name
     */
    getTool(name: string): Tool | undefined {
        return this.registry.get(name);
    }

    /**
     * Select the best tool for a given context
     */
    selectTool(context: ToolContext): Tool | null {
        return this.registry.selectBest(context);
    }

    /**
     * Execute a tool by name
     */
    async executeTool(name: string, context: ToolContext): Promise<ToolResult> {
        const tool = this.registry.get(name);
        if (!tool) {
            return {
                success: false,
                error: `Tool not found: ${name}`,
            };
        }
        return tool.execute(context);
    }

    /**
     * List all available tools
     */
    listTools(): { name: string; description: string; category: string }[] {
        return this.registry.getAll().map(tool => ({
            name: tool.name,
            description: tool.description,
            category: tool.category,
        }));
    }

    /**
     * Register a custom tool
     */
    registerTool(tool: Tool): void {
        this.registry.register(tool);
    }

    /**
     * Get tools by category
     */
    getToolsByCategory(category: Tool['category']): Tool[] {
        return this.registry.getByCategory(category);
    }
}
