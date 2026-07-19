import Redis from 'ioredis';

export interface EventWakeup { jobId:string; sequence:number }
export interface EventBus { publish(wakeup:EventWakeup):Promise<void>; subscribe(listener:(wakeup:EventWakeup)=>void):Promise<()=>Promise<void>>; close():Promise<void> }

export class InMemoryEventBus implements EventBus {
  private listeners=new Set<(w:EventWakeup)=>void>();
  async publish(w:EventWakeup) { for(const listener of this.listeners) listener(w); }
  async subscribe(listener:(w:EventWakeup)=>void) { this.listeners.add(listener); return async()=>{this.listeners.delete(listener);}; }
  async close() { this.listeners.clear(); }
}

export class RedisEventBus implements EventBus {
  private readonly publisher:Redis;
  private readonly subscriber:Redis;
  constructor(url:string,private readonly channel='adaptive-agent:service-events') { this.publisher=new Redis(url);this.subscriber=new Redis(url); }
  async publish(w:EventWakeup) { await this.publisher.publish(this.channel,JSON.stringify(w)); }
  async subscribe(listener:(w:EventWakeup)=>void) {
    const handler=(_channel:string,message:string)=>{ try { const value=JSON.parse(message);if(typeof value.jobId==='string'&&Number.isSafeInteger(value.sequence))listener(value); } catch {} };
    this.subscriber.on('message',handler);await this.subscriber.subscribe(this.channel);
    return async()=>{this.subscriber.off('message',handler);if(this.subscriber.listenerCount('message')===0)await this.subscriber.unsubscribe(this.channel);};
  }
  async close() { await Promise.all([this.publisher.quit(),this.subscriber.quit()]); }
}
