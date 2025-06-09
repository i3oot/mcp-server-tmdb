#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from 'express';
import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

// Type definitions
interface Movie {
  id: number;
  title: string;
  release_date: string;
  vote_average: number;
  overview: string;
  poster_path?: string;
  genres?: Array<{ id: number; name: string }>;
}

interface TMDBResponse {
  page: number;
  results: Movie[];
  total_pages: number;
}

interface MovieDetails extends Movie {
  credits?: {
    cast: Array<{
      name: string;
      character: string;
    }>;
    crew: Array<{
      name: string;
      job: string;
    }>;
  };
  reviews?: {
    results: Array<{
      author: string;
      content: string;
      rating?: number;
    }>;
  };
}

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

function createServer() {
  const server = new Server(
    {
      name: "example-servers/tmdb",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

async function fetchFromTMDB<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`);
  url.searchParams.append("api_key", TMDB_API_KEY!);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`TMDB API error: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function getMovieDetails(movieId: string): Promise<MovieDetails> {
  return fetchFromTMDB<MovieDetails>(`/movie/${movieId}`, { append_to_response: "credits,reviews" });
}

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const params: Record<string, string> = {
    page: request.params?.cursor || "1",
  };

  const data = await fetchFromTMDB<TMDBResponse>("/movie/popular", params);
  
  return {
    resources: data.results.map((movie) => ({
      uri: `tmdb:///movie/${movie.id}`,
      mimeType: "application/json",
      name: `${movie.title} (${movie.release_date.split("-")[0]})`,
    })),
    nextCursor: data.page < data.total_pages ? String(data.page + 1) : undefined,
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const movieId = request.params.uri.replace("tmdb:///movie/", "");
  const movie = await getMovieDetails(movieId);

  const movieInfo = {
    title: movie.title,
    releaseDate: movie.release_date,
    rating: movie.vote_average,
    overview: movie.overview,
    genres: movie.genres?.map(g => g.name).join(", "),
    posterUrl: movie.poster_path ?
      `https://image.tmdb.org/t/p/w500${movie.poster_path}` :
      "No poster available",
    cast: movie.credits?.cast?.slice(0, 5).map(actor => `${actor.name} as ${actor.character}`),
    director: movie.credits?.crew?.find(person => person.job === "Director")?.name,
    reviews: movie.reviews?.results?.slice(0, 3).map(review => ({
      author: review.author,
      content: review.content,
      rating: review.rating
    }))
  };

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(movieInfo, null, 2),
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_movies",
        description: "Search for movies by title or keywords",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for movie titles",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_recommendations",
        description: "Get movie recommendations based on a movie ID",
        inputSchema: {
          type: "object",
          properties: {
            movieId: {
              type: "string",
              description: "TMDB movie ID to get recommendations for",
            },
          },
          required: ["movieId"],
        },
      },
      {
        name: "get_trending",
        description: "Get trending movies for a time window",
        inputSchema: {
          type: "object",
          properties: {
            timeWindow: {
              type: "string",
              enum: ["day", "week"],
              description: "Time window for trending movies",
            },
          },
          required: ["timeWindow"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "search_movies": {
        const query = request.params.arguments?.query as string;
        const data = await fetchFromTMDB<TMDBResponse>("/search/movie", { query });
        
        const results = data.results
          .map((movie) =>
            `${movie.title} (${movie.release_date?.split("-")[0]}) - ID: ${movie.id}\n` +
            `Rating: ${movie.vote_average}/10\n` +
            `Overview: ${movie.overview}\n`
          )
          .join("\n---\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${data.results.length} movies:\n\n${results}`,
            },
          ],
          isError: false,
        };
      }

      case "get_recommendations": {
        const movieId = request.params.arguments?.movieId as string;
        const data = await fetchFromTMDB<TMDBResponse>(`/movie/${movieId}/recommendations`);
        
        const recommendations = data.results
          .slice(0, 5)
          .map((movie) =>
            `${movie.title} (${movie.release_date?.split("-")[0]})\n` +
            `Rating: ${movie.vote_average}/10\n` +
            `Overview: ${movie.overview}\n`
          )
          .join("\n---\n");

        return {
          content: [
            {
              type: "text",
              text: `Top 5 recommendations:\n\n${recommendations}`,
            },
          ],
          isError: false,
        };
      }

      case "get_trending": {
        const timeWindow = request.params.arguments?.timeWindow as string;
        const data = await fetchFromTMDB<TMDBResponse>(`/trending/movie/${timeWindow}`);
        
        const trending = data.results
          .slice(0, 10)
          .map((movie) =>
            `${movie.title} (${movie.release_date?.split("-")[0]})\n` +
            `Rating: ${movie.vote_average}/10\n` +
            `Overview: ${movie.overview}\n`
          )
          .join("\n---\n");

        return {
          content: [
            {
              type: "text",
              text: `Trending movies for the ${timeWindow}:\n\n${trending}`,
            },
          ],
          isError: false,
        };
      }

      default:
        throw new Error("Tool not found");
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        },
      ],
      isError: true,
    };
  }
});

  return server;
}

// Start the server using the transport specified by MCP_TRANSPORT
if (!TMDB_API_KEY) {
  console.error("TMDB_API_KEY environment variable is required");
  process.exit(1);
}

const transportType = (process.env.MCP_TRANSPORT || 'STDIO').toUpperCase();

switch (transportType) {
  case 'SSE': {
    const app = express();
    app.use(express.json());
    const transports: Record<string, SSEServerTransport> = {};

    app.get('/mcp', async (req, res) => {
      const transport = new SSEServerTransport('/messages', res);
      transports[transport.sessionId] = transport;
      transport.onclose = () => {
        delete transports[transport.sessionId];
      };
      const server = createServer();
      await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
      const sessionId = String(req.query.sessionId);
      const transport = transports[sessionId];
      if (!transport) {
        res.status(404).send('Session not found');
        return;
      }
      await transport.handlePostMessage(req, res, req.body);
    });

    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => {
      console.log(`TMDB MCP server (SSE) listening on port ${port}`);
    });
    break;
  }
  case 'HTTP': {
    const app = express();
    app.use(express.json());
    const transports: Record<string, StreamableHTTPServerTransport> = {};

    app.post('/mcp', async (req, res) => {
      let transport: StreamableHTTPServerTransport | undefined;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) delete transports[sid];
        };
        const server = createServer();
        await server.connect(transport);
        if (transport.sessionId) {
          transports[transport.sessionId] = transport;
        }
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    });

    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId && transports[sessionId];
      if (!transport) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      await transport.handleRequest(req, res);
    });

    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId && transports[sessionId];
      if (!transport) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }
      await transport.handleRequest(req, res);
    });

    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => {
      console.log(`TMDB MCP server (HTTP) listening on port ${port}`);
    });
    break;
  }
  case 'STDIO':
  default: {
    const server = createServer();
    const transport = new StdioServerTransport();
    server.connect(transport).catch((error) => {
      console.error('Server connection error:', error);
      process.exit(1);
    });
  }
}
