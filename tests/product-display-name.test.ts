import {it,expect} from 'vitest';
import {displayProjectName} from '@/lib/domain/products/display-name';
it('removes only the matching repository owner prefix',()=>{
 expect(displayProjectName('chamber-orchestra/metadata-bundle','https://github.com/chamber-orchestra/metadata-bundle')).toBe('metadata-bundle');
 expect(displayProjectName('Owner/Repo','https://github.com/owner/repo.git')).toBe('Repo');
 for(const name of ['Studio / Notes','Research/Design','Custom Product'])expect(displayProjectName(name,'https://github.com/owner/repo')).toBe(name);
 expect(displayProjectName('owner/repo',null)).toBe('owner/repo');
 expect(displayProjectName('owner/repo','https://example.com/owner/repo')).toBe('owner/repo');
});
