import { EventEmitter } from 'events';

export default class Eventhandler {
    static counter: number=0;
	static bindings = new Map<string, (...args:any[])=>any>();
	static emitter: EventEmitter;
	static requestTimeout: number;
	constructor(emitter: EventEmitter, requestTimeout?:number){
		Eventhandler.emitter = emitter;
		if(requestTimeout==undefined){
			Eventhandler.request<number>("Kernel:Config:RequestTimeout").then((requestTimeout)=>
			{
				console.log("Got timeout: "+requestTimeout);
				Eventhandler.requestTimeout=requestTimeout
			});
		}
		else{
			Eventhandler.requestTimeout = requestTimeout;
		}
	}

	static request<T>(eventName: string, ...args: any[]): Promise<T> {
		var promise = new Promise<T>(async (resolve, reject) => {
			const curCounter = Eventhandler.counter++;
			var resolved = false;
			let func = (counter: number, data: any) => {
				if (counter != curCounter) return;
				this.emitter.off(eventName + ":Result", func);
				resolved = true;
				resolve(data);
				return;
			}
			this.emitter.on(eventName + ":Result", func);
			this.emitter.emit(eventName, curCounter, ...args);
			await sleep(Eventhandler.requestTimeout);
			if (resolved) return;
			this.emitter.off(eventName + ":Result", func);
			reject(null);
		});
		return promise;
	}

	static bind(eventName:string, func: (...args: any[]) => any):void{
		let funcIdent = eventName + String(func).hashCode();
		if (this.bindings.get(funcIdent)) return;
		let helpFunc = async (counter: number, ...args: any[]) => {
			if (args) this.emitter.emit(eventName + ":Result", counter, await func.apply(null, args));
			else this.emitter.emit(eventName + ":Result", counter, await func());
		}
		this.emitter.on(eventName, helpFunc);
		this.bindings.set(funcIdent, helpFunc);
	}

	static unbind(eventName: string, method: (...args: any[]) => any) {
		let funcIdent = eventName + String(method).hashCode();
		let helpFunc = this.bindings.get(funcIdent);
		if(!helpFunc) return;
		this.emitter.off(eventName, helpFunc);
		this.bindings.delete(funcIdent);
	}

	static emit(eventName:string, ...data:any[]){
		this.emitter.emit(eventName, 0, ...data);
	}
}

	async function sleep(ms:number): Promise<void>{
		return new Promise((resolve, reject)=>{
			setTimeout(()=>resolve(),ms);
		})
	}

declare global {
	interface String {
		hashCode(): number;
	}
}

String.prototype.hashCode = function (this: string): number {
	var s = this
	var hash = 0;
	if (s.length == 0) {
		return hash;
	}
	for (var i = 0; i < s.length; i++) {
		var char = s.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32bit integer
	}
	return hash;
}
