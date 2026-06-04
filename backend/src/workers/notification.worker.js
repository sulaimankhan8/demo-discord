import { worker } from 'bullmq';


new Worker(
    "notifications",
    async (job) =>{
        console.log(job.data);
    },{
        connection: redis,
    }
);