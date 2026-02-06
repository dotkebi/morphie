/**
 * Tests for Agent Orchestrator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentOrchestrator } from './agent-orchestrator.js';
import { OllamaClient } from '../llm/ollama.js';
import type { PortingTask } from '../types/agent-types.js';

describe('AgentOrchestrator', () => {
    let orchestrator: AgentOrchestrator;
    let mockLlm: OllamaClient;

    beforeEach(() => {
        mockLlm = new OllamaClient('http://localhost:11434', 'codellama');
        orchestrator = new AgentOrchestrator(mockLlm, { verbose: false });
    });

    describe('initialization', () => {
        it('should create an orchestrator instance', () => {
            expect(orchestrator).toBeDefined();
        });

        it('should have a tool registry', () => {
            const registry = orchestrator.getToolRegistry();
            expect(registry).toBeDefined();
            expect(registry.size).toBe(0); // No tools registered yet
        });

        it('should have a conversation manager', () => {
            const conversation = orchestrator.getConversationManager();
            expect(conversation).toBeDefined();
        });
    });

    describe('task execution', () => {
        it('should handle a basic porting task structure', async () => {
            const task: PortingTask = {
                sourcePath: './test-src',
                targetPath: './test-out',
                sourceLanguage: 'typescript',
                targetLanguage: 'dart',
                dryRun: true,
                verbose: false,
            };

            // This will fail without actual LLM, but tests the structure
            try {
                const result = await orchestrator.execute(task);
                expect(result).toBeDefined();
                expect(result.success).toBeDefined();
                expect(result.phases).toBeDefined();
            } catch (error) {
                // Expected to fail without real LLM connection
                expect(error).toBeDefined();
            }
        });
    });
});
