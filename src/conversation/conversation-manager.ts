/**
 * Conversation Manager - Tracks context, thoughts, and learnings across agent execution
 */

import type {
    Message,
    Thought,
    ConversationContext,
    PortingTask,
    ProjectInfo,
    Pattern,
} from '../types/agent-types.js';

export class ConversationManager {
    private messages: Message[] = [];
    private thoughts: Thought[] = [];
    private learnings: string[] = [];
    private patterns: Pattern[] = [];
    private currentTask: PortingTask | null = null;
    private projectInfo: ProjectInfo | null = null;
    private metadata: Map<string, any> = new Map();

    /**
     * Start a new task and initialize conversation
     */
    startTask(task: PortingTask): void {
        this.currentTask = task;
        this.messages = [];
        this.thoughts = [];

        // Add initial system message
        this.addMessage('system', `Starting porting task: ${task.sourceLanguage} → ${task.targetLanguage}`);
    }

    /**
     * End the current task
     */
    endTask(): void {
        this.addMessage('system', 'Task completed');
        this.currentTask = null;
    }

    /**
     * Add a message to the conversation
     */
    addMessage(role: Message['role'], content: string): void {
        this.messages.push({
            role,
            content,
            timestamp: new Date(),
        });
    }

    /**
     * Add a thought (internal reasoning)
     */
    addThought(type: Thought['type'], content: any, phase?: number): void {
        this.thoughts.push({
            type,
            content,
            timestamp: new Date(),
            phase,
        });
    }

    /**
     * Add learnings from the current execution
     */
    addLearnings(learnings: string[]): void {
        this.learnings.push(...learnings);
    }

    /**
     * Add a successful pattern for future reference
     */
    addPattern(pattern: Pattern): void {
        // Check if pattern already exists
        const existing = this.patterns.find(p => p.name === pattern.name);
        if (existing) {
            existing.frequency++;
        } else {
            this.patterns.push({ ...pattern, frequency: 1 });
        }
    }

    /**
     * Set project information
     */
    setProjectInfo(info: ProjectInfo): void {
        this.projectInfo = info;
    }

    /**
     * Get full conversation context
     */
    getContext(): ConversationContext {
        return {
            messages: this.messages,
            thoughts: this.thoughts,
            learnings: this.learnings,
            currentTask: this.currentTask ?? undefined,
            projectInfo: this.projectInfo ?? undefined,
        };
    }

    /**
     * Get project information
     */
    getProjectInfo(): ProjectInfo | null {
        return this.projectInfo;
    }

    /**
     * Get current task
     */
    getCurrentTask(): PortingTask | null {
        return this.currentTask;
    }

    /**
     * Get recent thoughts of a specific type
     */
    getRecentThoughts(type?: Thought['type'], count: number = 5): Thought[] {
        let filtered = this.thoughts;

        if (type) {
            filtered = filtered.filter(t => t.type === type);
        }

        return filtered.slice(-count);
    }

    /**
     * Get all learnings
     */
    getLearnings(): string[] {
        return [...this.learnings];
    }

    /**
     * Get patterns, optionally sorted by frequency
     */
    getPatterns(sortByFrequency: boolean = true): Pattern[] {
        const patterns = [...this.patterns];

        if (sortByFrequency) {
            patterns.sort((a, b) => b.frequency - a.frequency);
        }

        return patterns;
    }

    /**
     * Get the most relevant patterns for a given context
     */
    getRelevantPatterns(keywords: string[], limit: number = 5): Pattern[] {
        const scored = this.patterns.map(pattern => {
            let score = pattern.frequency;

            // Boost score if keywords match
            keywords.forEach(keyword => {
                const lowerKeyword = keyword.toLowerCase();
                if (pattern.name.toLowerCase().includes(lowerKeyword) ||
                    pattern.description.toLowerCase().includes(lowerKeyword)) {
                    score += 10;
                }
            });

            return { pattern, score };
        });

        // Sort by score and return top N
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(s => s.pattern);
    }

    /**
     * Store custom metadata
     */
    setMetadata(key: string, value: any): void {
        this.metadata.set(key, value);
    }

    /**
     * Get custom metadata
     */
    getMetadata(key: string): any {
        return this.metadata.get(key);
    }

    /**
     * Build context string for LLM prompts
     */
    buildContextString(includeThoughts: boolean = false): string {
        const parts: string[] = [];

        // Add task info
        if (this.currentTask) {
            parts.push(`CURRENT TASK: Porting from ${this.currentTask.sourceLanguage} to ${this.currentTask.targetLanguage}`);
        }

        // Add project info
        if (this.projectInfo) {
            parts.push(`PROJECT: ${this.projectInfo.projectName}`);
            parts.push(`Total files: ${this.projectInfo.totalFiles}`);
        }

        // Add recent learnings
        if (this.learnings.length > 0) {
            parts.push('\nLEARNINGS:');
            this.learnings.slice(-5).forEach((learning, i) => {
                parts.push(`${i + 1}. ${learning}`);
            });
        }

        // Add relevant patterns
        if (this.patterns.length > 0) {
            parts.push('\nSUCCESSFUL PATTERNS:');
            this.getPatterns(true).slice(0, 3).forEach((pattern, i) => {
                parts.push(`${i + 1}. ${pattern.name}: ${pattern.description} (used ${pattern.frequency}x)`);
            });
        }

        // Optionally add recent thoughts
        if (includeThoughts && this.thoughts.length > 0) {
            parts.push('\nRECENT REASONING:');
            this.getRecentThoughts(undefined, 3).forEach((thought, i) => {
                parts.push(`${i + 1}. [${thought.type}] ${JSON.stringify(thought.content).slice(0, 100)}...`);
            });
        }

        return parts.join('\n');
    }

    /**
     * Export conversation to JSON
     */
    export(): string {
        return JSON.stringify({
            messages: this.messages,
            thoughts: this.thoughts,
            learnings: this.learnings,
            patterns: this.patterns,
            currentTask: this.currentTask,
            projectInfo: this.projectInfo,
            metadata: Array.from(this.metadata.entries()),
            exportedAt: new Date().toISOString(),
        }, null, 2);
    }

    /**
     * Import conversation from JSON
     */
    import(data: string): void {
        try {
            const parsed = JSON.parse(data);

            this.messages = parsed.messages || [];
            this.thoughts = parsed.thoughts || [];
            this.learnings = parsed.learnings || [];
            this.patterns = parsed.patterns || [];
            this.currentTask = parsed.currentTask || null;
            this.projectInfo = parsed.projectInfo || null;

            if (parsed.metadata) {
                this.metadata = new Map(parsed.metadata);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to import conversation: ${message}`);
        }
    }

    /**
     * Clear all conversation data
     */
    clear(): void {
        this.messages = [];
        this.thoughts = [];
        this.learnings = [];
        this.patterns = [];
        this.currentTask = null;
        this.projectInfo = null;
        this.metadata.clear();
    }

    /**
     * Get conversation statistics
     */
    getStats(): {
        messageCount: number;
        thoughtCount: number;
        learningCount: number;
        patternCount: number;
        duration?: number;
    } {
        const stats = {
            messageCount: this.messages.length,
            thoughtCount: this.thoughts.length,
            learningCount: this.learnings.length,
            patternCount: this.patterns.length,
        };

        // Calculate duration if we have messages
        if (this.messages.length >= 2) {
            const first = this.messages[0].timestamp.getTime();
            const last = this.messages[this.messages.length - 1].timestamp.getTime();
            return {
                ...stats,
                duration: last - first,
            };
        }

        return stats;
    }

    /**
     * Get a summary of the conversation
     */
    getSummary(): string {
        const stats = this.getStats();
        const parts: string[] = [];

        parts.push(`Conversation Summary:`);
        parts.push(`- Messages: ${stats.messageCount}`);
        parts.push(`- Thoughts: ${stats.thoughtCount}`);
        parts.push(`- Learnings: ${stats.learningCount}`);
        parts.push(`- Patterns: ${stats.patternCount}`);

        if (stats.duration) {
            const minutes = Math.floor(stats.duration / 60000);
            const seconds = Math.floor((stats.duration % 60000) / 1000);
            parts.push(`- Duration: ${minutes}m ${seconds}s`);
        }

        if (this.currentTask) {
            parts.push(`- Task: ${this.currentTask.sourceLanguage} → ${this.currentTask.targetLanguage}`);
        }

        return parts.join('\n');
    }
}
