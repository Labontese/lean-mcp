#!/usr/bin/env node
import { LeanMcpServer } from './server.js';

const server = new LeanMcpServer();
server.start();
