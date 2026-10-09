import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server';
import { Pool } from 'pg'; // Import Pool type for casting

// Define a mock Pool instance that we can spy on
const mockPgPool = {
    end: vi.fn(() => Promise.resolve()), // Mock the end method
    connect: vi.fn(() => ({
        release: vi.fn(),
        query: vi.fn(),
    })),
    // Add other necessary mock methods if used by the app
} as unknown as Pool; // Cast to Pool to satisfy type checker

// Mock the entire src/db/client module to control its behavior
vi.mock('../src/db/client', () => {
    let currentPool: Pool | null = null; // This will hold our mock pool instance

    return {
        initDb: vi.fn((config: any) => {
            if (!currentPool) {
                currentPool = mockPgPool; // Assign our mock pool when initDb is called
            }
            return currentPool;
        }),
        closeDb: vi.fn(async () => {
            if (currentPool) {
                await currentPool.end(); // Call the mock pool's end method
                currentPool = null; // Simulate clearing the pool reference
            }
        }),
        getDbPool: vi.fn(() => {
            if (!currentPool) {
                throw new Error('Mock Database pool not initialized.');
            }
            return currentPool;
        }),
    };
});

describe('Application Lifecycle', () => {
    let app: Awaited<ReturnType<typeof buildServer>>;
    let closeDbSpy: ReturnType<typeof vi.spyOn>;
    let mockPoolEndSpy: ReturnType<typeof vi.spyOn>;
    let initDbSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        // Clear all mocks before each test to ensure isolation
        vi.clearAllMocks();

        // Import the mocked functions from the client module
        const clientModule = await import('../src/db/client');

        // Spy on the mocked initDb and closeDb functions
        initDbSpy = vi.spyOn(clientModule, 'initDb');
        closeDbSpy = vi.spyOn(clientModule, 'closeDb');

        // Ensure initDb is called to set up the mock pool within the mocked module.
        // This simulates the main application calling initDb before building the server.
        clientModule.initDb({});

        // Spy on the 'end' method of our specific mockPgPool instance
        mockPoolEndSpy = vi.spyOn(mockPgPool, 'end');

        // Build the Fastify server
        app = buildServer();
    });

    afterEach(async () => {
        // Ensure the server is closed after each test if it was started
        if (app && app.server.listening) {
            await app.close();
        }
    });

    it('should close the PostgreSQL pool during application shutdown', async () => {
        // Trigger application shutdown by calling app.close()
        await app.close();

        // Acceptance Criteria 1: app.close() ends the pool (asserted via a spy)
        // Assert that the closeDb function was called exactly once
        expect(closeDbSpy).toHaveBeenCalledTimes(1);

        // Assert that the underlying mock pool's end() method was called exactly once
        expect(mockPoolEndSpy).toHaveBeenCalledTimes(1);

        // Acceptance Criteria 2: Shutdown returns only after the pool is closed
        // This is implicitly tested by awaiting app.close() and then performing assertions.
        // If closeDb was not awaited within the hook, the spy might not have been called yet.

        // Optional: Verify initDb was called (good for overall lifecycle testing)
        expect(initDbSpy).toHaveBeenCalledTimes(1);
    });
});
