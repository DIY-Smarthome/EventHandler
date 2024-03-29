import * as net from 'net';
import peer from 'noise-peer';
import { v4 as getUUID } from 'uuid';

import Delegate from './Utils/Delegate/Delegate';
import { DetailedStatus } from './Utils/enums/DetailedStatus';
import { LogLevel } from './Utils/enums/LogLevel';
import { Configdata } from './Utils/interfaces/Configdata';
import { Eventdata } from './Utils/interfaces/Eventdata';
import { Response } from './Utils/interfaces/Response';
import { ResponseArray } from './Utils/interfaces/ResponseArray';


export default class EventHandler {
	private modulename: string;
	private config: Configdata;
	private bindings: Map<string, Delegate<(...args) => unknown>> = new Map();

	/*private kernelHostname: string;*/
	private kernelPort: number;

	private secStream: peer.NoisePeer;

	private pendingMessages: Map<string, (value: ResponseArray | PromiseLike<ResponseArray>) => void>;
	
	disposed = false;
	
	static shutdownEvent = "control/shutdown";
	private static instance = null;
	/**
	 * Creates a new, not initialized, instance of an EventHandler
	 * @see {@link init} for initializing
	 * @param kernelhost Hostname of the kernel
	 * @param kernelport Port the kernel is listening on
	 * @param modulename optional - provide a custom name for this Eventhandler
	 * @param requestTimeout optional - timeout in milliseconds
	 * @param logLevel optional - provide a custom loglevel
	 */
	constructor(/*kernelhost: string,*/ kernelport: number, config: Configdata, modulename?:string) {
		this.config = config;
		/*this.kernelHostname = kernelhost;*/
		this.kernelPort = kernelport;
		this.modulename = modulename;
		this.pendingMessages = new Map<string, (value: ResponseArray | PromiseLike<ResponseArray>) => void>();
	}

	/**
	 * Initializes the eventhandler
	 */
	init(): Promise<ResponseArray> {
		//Dispose Logic for shutdowns
		[`beforeExit`, `SIGINT`, `SIGUSR1`, `SIGUSR2`, `uncaughtException`, `SIGTERM`].forEach((eventType) => {
			process.on(eventType, async (code) => {
				console.log(`About to exit with code: ${code}`);
				await this.dispose();
				process.exit(code); //Do not prevent any kind of user induced shutdown 
			});//Arrow function to preserve class context
		})
		
		EventHandler.instance = this;

		var stream = net.connect(this.kernelPort/*, this.kernelHostname*/);
		this.secStream = peer(stream, true);
		
		
		this.secStream.on('data', async (body) => { //convert chunk buffers to string
			const data: Eventdata = JSON.parse(body);
			body = ""; //reset body
			if(!data)
				return;

			if(this.pendingMessages.has(data.id))
			{
				this.pendingMessages.get(data.id).apply(null, [new ResponseArray(...((data.payload??[]) as Array<Response>))]);
				this.pendingMessages.delete(data.id);
				return;
			}

			const eventname = data.eventname;						
			if (!this.bindings.has(eventname)) //if there is no event, don't process
				return;
			const [results, unfinished] = await this.bindings.get(eventname).invokeAsync(data.timeout, data.payload); //invoke subscribed functions
			const processedResults: Response = { //pack results
				id: data.id,
				modulename: this.modulename,
				statuscode: unfinished==0?200:207,
				detailedstatus: unfinished==0? "" : DetailedStatus.PARTIAL_TIMEOUT+"|"+unfinished,
				content: results
			}
			this.secStream.write(JSON.stringify(processedResults)); //return results
		});

		return this.doRequest(this.secStream, "kernel/init", this.config.timeout, {});// Init client for incoming messages
	}

	/**
	 * Request data from other modules
	 * @param eventname The eventname to request
	 * @param payload optional - Additional parameters
	 * @returns All responses
	 */
	request(eventname: string, payload: unknown = {}): Promise<ResponseArray> {
		return this.requestCustomTimeout(eventname, this.config.timeout, payload);
	}

	/**
	 * Request data from other modules with a custom timeout
	 * @param eventname The eventname to request
	 * @param timeout Timeout in milliseconds
	 * @param payload optional - Additional parameters
	 * @returns All responses
	 */
	requestCustomTimeout(eventname: string, timeout: number, payload: unknown = {}): Promise<ResponseArray> {
		return this.doRequest(this.secStream, eventname, timeout, payload);
	}

	/**
	 * Request function for internal use (Logger is set to null to prevent response loops when using logging)
	 * @param eventname The eventname to request
	 * @param timeout Timeout in milliseconds
	 * @param payload optional - Additional parameters
	 * @returns All responses 
	 */
	private requestInternal(eventname: string, timeout: number, payload: unknown = {}): Promise<ResponseArray>{
		return this.doRequest(this.secStream, eventname, timeout, payload);
	}

	/**
	 * Subscribe to future events of the given event
	 * @param eventname Name of the event
	 * @param func Callback function
	 * @param classcontext optional - classcontext to execute function in
	 */
	subscribe(eventname: string, func: (...args) => unknown, classcontext?: unknown):void {
		if (!this.bindings.has(eventname)) {
			this.bindings.set(eventname, new Delegate())
			this.request("kernel/subscribe", {
				eventname: eventname
			});
		}
		this.bindings.get(eventname).bind(func, classcontext);
	}

	/**
	 * Unsubscribe from future events of the given event
	 * @param eventname Name of the event
	 * @param func Callback function
	 * @param classcontext optional - classcontext to execute function in
	 */
	unsubscribe(eventname: string, func: (...args) => unknown, classcontext?: unknown):void {
		if (!this.bindings.has(eventname))
			return;
		this.bindings.get(eventname).unbind(func, classcontext);

		if(this.bindings.get(eventname).funcs.length==0){
			this.bindings.delete(eventname);
			return;
		}

		this.request("kernel/unsubscribe", {
			eventname: eventname
		});
	}

	/**
	 * Dispose the eventhandler
	 */
	async dispose(): Promise<void> {
		if (this.disposed)
			return;
		
		this.disposed = true; //to prevent double disposal
		[`beforeExit`, `SIGINT`, `SIGUSR1`, `SIGUSR2`, `uncaughtException`, `SIGTERM`].forEach((eventType) => { //remove listeners to allow the process to stop
			process.off(eventType, () => this.dispose);//Arrow function to preserve class context
		})
		this.bindings.clear(); //Remove all bindings
		try {
			await this.request("kernel/dispose"); //Notify kernel of dispose
			this.secStream.destroy(); //Close server for incoming messages
		} catch (e) {
			console.error(e); 
		}
	}

	/**
	 * Get the provided modulename of this EventHandler
	 * @returns Modulename
	 */
	getModuleName(): string {
		return this.modulename;
	}

	/**
	 * Special Log function. Currently hardcoded on Kernel side, will call Log modules later on.
	 * @param logLevel The Loglevel to use
	 * @param content The message to write
	 */
	async Log(logLevel: LogLevel, content: string): Promise<void> {
		if (logLevel < this.config.loglevel)
			return;

		this.requestInternal("kernel/log", this.config.timeout, {
			message: `[${new Date().toISOString()}] ${("[" + LogLevel[logLevel] + "]").padEnd(9, " ")} [${this.modulename}] ${content}`
		})
	}

	/**
	 * Wraps all internal Request/Response Logics for easy use
	 * @param SecStream The secured noise-peer stream
	 * @param path The path to request
	 * @param payload JSON payload
	 * @param logger parameter to prevent Loops/Deadlocks
	 * @returns The Responses from the kernel/the modules
	 */
	 private doRequest(SecStream: peer.NoisePeer, path: string, timeout:number, payload: unknown, logger = this): Promise<ResponseArray> {
		let uuid = getUUID()
		let prm = new Promise<ResponseArray>((resolve, reject) => {
			this.pendingMessages.set(uuid, resolve);
			const data: Eventdata = {
				id: uuid,
				pass: this.config.pass,
				modulename: this.modulename,
				eventname: path,
				timeout: timeout,
				payload: payload
			}
			logger?.Log(LogLevel.Debug, "Eventhandler wrote: " + JSON.stringify(data));
			//Prepare request with response logic
			SecStream.write(JSON.stringify(data));
		});
		return prm;
	}

	static getInstance() {
		return EventHandler.instance;
	}
}
