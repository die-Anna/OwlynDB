import { contextBridge, ipcRenderer } from 'electron';
import type { IpcReply } from '../shared/api-types';

contextBridge.exposeInMainWorld('dbv', {
  async call(method: string, ...args: unknown[]): Promise<unknown> {
    const reply = (await ipcRenderer.invoke('dbv', method, args)) as IpcReply<unknown>;
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  },
});
