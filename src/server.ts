import express from 'express';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// Store active connections
const clients = new Map<string, WebSocket>();
const calls = new Map<string, CallSession>();

interface CallSession {
  id: string;
  caller: string;
  callee: string;
  status: 'ringing' | 'active' | 'ended';
  startTime: Date;
}

// WebSocket handling for signaling
wss.on('connection', (ws: WebSocket) => {
  let clientId: string | null = null;

  ws.on('message', async (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'register':
          if (data.clientId && typeof data.clientId === 'string') {
            const newClientId: string = data.clientId;
            clientId = newClientId;
            clients.set(newClientId, ws);
            ws.send(JSON.stringify({ type: 'registered', clientId: newClientId }));
            console.log(`Client registered: ${newClientId}`);
          }
          break;

        case 'call':
          if (clientId) {
            handleCall(data, clientId);
          }
          break;

        case 'answer':
          handleAnswer(data);
          break;

        case 'ice-candidate':
          handleIceCandidate(data);
          break;

        case 'hangup':
          handleHangup(data);
          break;

        case 'offer':
        case 'sdp':
          forwardSignal(data);
          break;

        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    if (clientId) {
      clients.delete(clientId);
      console.log(`Client disconnected: ${clientId}`);
    }
  });
});

function handleCall(data: any, callerId: string) {
  const callId = `call-${Date.now()}`;
  const callSession: CallSession = {
    id: callId,
    caller: callerId,
    callee: data.to,
    status: 'ringing',
    startTime: new Date()
  };
  
  calls.set(callId, callSession);
  
  const calleeWs = clients.get(data.to);
  if (calleeWs) {
    calleeWs.send(JSON.stringify({
      type: 'incoming-call',
      callId,
      from: callerId,
      offer: data.offer
    }));
  } else {
    const callerWs = clients.get(callerId);
    callerWs?.send(JSON.stringify({
      type: 'call-failed',
      reason: 'User not available'
    }));
  }
}

function handleAnswer(data: any) {
  const call = calls.get(data.callId);
  if (call) {
    call.status = 'active';
    const callerWs = clients.get(call.caller);
    callerWs?.send(JSON.stringify({
      type: 'call-answered',
      callId: data.callId,
      answer: data.answer
    }));
  }
}

function handleIceCandidate(data: any) {
  const targetWs = clients.get(data.to);
  if (targetWs) {
    targetWs.send(JSON.stringify({
      type: 'ice-candidate',
      candidate: data.candidate,
      from: data.from
    }));
  }
}

function handleHangup(data: any) {
  const call = calls.get(data.callId);
  if (call) {
    call.status = 'ended';
    
    [call.caller, call.callee].forEach(userId => {
      const ws = clients.get(userId);
      ws?.send(JSON.stringify({
        type: 'call-ended',
        callId: data.callId
      }));
    });
    
    calls.delete(data.callId);
  }
}

function forwardSignal(data: any) {
  const targetWs = clients.get(data.to);
  if (targetWs) {
    targetWs.send(JSON.stringify(data));
  }
}

// REST API endpoints
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    activeClients: clients.size,
    activeCalls: Array.from(calls.values()).filter(c => c.status === 'active').length
  });
});

app.get('/api/calls', (req, res) => {
  res.json({
    calls: Array.from(calls.values())
  });
});

// AI Agent endpoint (free tier - using simple logic for now)
app.post('/api/ai/process', async (req, res) => {
  const { transcript, context } = req.body;
  
  // Simple rule-based AI agent (can be extended with free APIs)
  const response = await processWithAI(transcript, context);
  
  res.json(response);
});

async function processWithAI(transcript: string, context: any) {
  const aisecResponse = await processWithAISec(transcript, context);
  if (aisecResponse) {
    return aisecResponse;
  }

  return processWithRules(transcript);
}

async function processWithAISec(transcript: string, context: any) {
  const aisecUrl = process.env.AISEC_API_URL;
  if (!aisecUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(aisecUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.AISEC_API_KEY ? { Authorization: `Bearer ${process.env.AISEC_API_KEY}` } : {})
      },
      body: JSON.stringify({ transcript, context }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`AISec request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      intent?: string;
      response?: string;
      action?: string;
    };
    if (data && typeof data.response === 'string') {
      return {
        intent: data.intent ?? 'aisec',
        response: data.response,
        action: data.action ?? 'respond'
      };
    }
  } catch (error) {
    console.error(`AISec integration failed for ${aisecUrl}:`, error);
  } finally {
    clearTimeout(timeout);
  }

  return null;
}

function processWithRules(transcript: string) {
  // Simple keyword-based responses (free alternative to paid AI)
  const lowerTranscript = transcript.toLowerCase();

  // Check for transfer/forward first (more specific)
  if (lowerTranscript.includes('transfer') || lowerTranscript.includes('forward')) {
    return {
      intent: 'transfer',
      response: 'I can transfer your call. Which department would you like?',
      action: 'request_transfer_target'
    };
  }

  if (lowerTranscript.includes('help')) {
    return {
      intent: 'help',
      response: 'I can help you with call management, transfers, and information. What do you need?',
      action: 'provide_help'
    };
  }

  if (lowerTranscript.includes('hello') || lowerTranscript.includes('hi')) {
    return {
      intent: 'greeting',
      response: 'Hello! How can I assist you today?',
      action: 'none'
    };
  }

  return {
    intent: 'unknown',
    response: 'I understand. Could you please provide more details?',
    action: 'clarify'
  };
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Swireit server running on port ${PORT}`);
  console.log(`📞 WebSocket signaling ready`);
  console.log(`🤖 AI agent tools enabled`);
  console.log(`💰 100% Free and Open Source`);
});
