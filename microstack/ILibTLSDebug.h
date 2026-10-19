/*
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

#ifndef ___ILibTLSDebug___
#define ___ILibTLSDebug___

//
// Opt-in TLS trace, enabled with "tlsDebug=<level>" in the agent's .msh / database.
//
//   0  off (default)
//   1  connection events: TLS setup, handshake start/done, alerts, certificate verification,
//      Windows root-store lookups, read/write/handshake errors, socket close with reason
//   2  verbose: every handshake state, every recv/SSL_read/SSL_write with byte counts
//
// Every line is timestamped (milliseconds) and carries the thread id. Lines go to stdout and,
// once ILibTLSDebug_SetLogFile() has been called, are appended to that file as well, so the
// trace also works when the agent runs as a service.
//
extern int ILibTLSDebug_Level;
void ILibTLSDebug_SetLogFile(const char *path);
const char* ILibTLSDebug_GetLogFile(void);
void ILibTLSDebug_printf(const char *format, ...);

// Child processes: the level and file are also carried in the environment variables
// MESHAGENT_TLSDEBUG and MESHAGENT_TLSDEBUG_FILE. ILibTLSDebug_InitFromEnv() picks them up
// at process start (no-op when the trace is already on), ILibTLSDebug_ExportToEnv() sets them
// in the current process so spawned children inherit them.
#define ILibTLSDebug_ENV_LEVEL "MESHAGENT_TLSDEBUG"
#define ILibTLSDebug_ENV_FILE  "MESHAGENT_TLSDEBUG_FILE"
void ILibTLSDebug_InitFromEnv(void);
void ILibTLSDebug_ExportToEnv(void);

#define ILibTLSDebug(level, ...) do { if (ILibTLSDebug_Level >= (level)) { ILibTLSDebug_printf(__VA_ARGS__); } } while (0)

#endif
