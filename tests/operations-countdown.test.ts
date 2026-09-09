import { expect, it } from 'vitest';
import { remainingSeconds } from '@/lib/operations/countdown';
it('counts down from the server deadline and never goes negative',()=>{
 const server=1_800_000_000_000;
 expect(remainingSeconds(server+35000,server)).toBe(35);
 expect(remainingSeconds(server+35000,server,1000)).toBe(34);
 expect(remainingSeconds(server+35000,server,36000)).toBe(0);
 expect(remainingSeconds(server+45000,server,5000)).toBe(40);
 expect(remainingSeconds(server+600000,server,65000)).toBe(535);
});
it('resumes the remaining time after reopening instead of restarting the countdown',()=>{
 const deadline=100000;
 expect(remainingSeconds(deadline,75000,2000)).toBe(23);
 expect(remainingSeconds(deadline,80000)).toBe(20);
});
