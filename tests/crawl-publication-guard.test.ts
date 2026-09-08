import { expect, it } from "vitest";
import { assertPublicationSnapshot, publicationSourceChanged } from "@/lib/crawl/publication-guard";
const snapshot={candidate:{state:"approved",updatedAt:new Date(0)},document:{productUrl:"https://one.example"},settings:{enabled:true}};
it("blocks an admin rejection arriving during category classification",()=>{
  expect(()=>assertPublicationSnapshot(snapshot,{...snapshot,candidate:{...snapshot.candidate,state:"rejected"}})).toThrow("publication_state_changed");
});
it("blocks a changed source repository or policy before insertion",()=>{
  expect(()=>assertPublicationSnapshot(snapshot,{...snapshot,document:{productUrl:"https://other.example"}})).toThrow();
  expect(()=>assertPublicationSnapshot(snapshot,{...snapshot,settings:{enabled:false}})).toThrow();
  expect(()=>assertPublicationSnapshot(snapshot,snapshot)).not.toThrow();
});
it("holds already inconsistent candidate and document URLs, including a removed homepage",()=>{
  expect(publicationSourceChanged({productUrl:"https://old.example"},{productUrl:"https://new.example"})).toBe(true);
  expect(publicationSourceChanged({productUrl:"https://old.example"},{productUrl:null})).toBe(true);
  expect(publicationSourceChanged({productUrl:"https://same.example"},{productUrl:"https://same.example"})).toBe(false);
});
