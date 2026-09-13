import{it,expect}from'vitest';import{nonProductPurpose}from'@/lib/crawl/product-purpose';
it('excludes respondent surveys and personal research documents',()=>{
 for(const input of[
 {title:'OTT 플랫폼 추천 기능에 대한 사용자 경험 연구',description:'홍익대학교 대학원 석사학위논문 실험 설문'},
 {title:'Participant Survey',textSample:'This academic research questionnaire takes 10 minutes. Participation is voluntary and responses are anonymous.'},
 {title:'Latent Coffee Research',description:'Personal coffee research journal'},
 {title:'Ontology, knowledge graph and AI research publications',description:'Academic publications and reports'},
 {title:'개인 연구 노트',description:'논문 읽고 정리한 기록'},
 ])expect(nonProductPurpose(input)).not.toBeNull();
});
it('keeps reusable survey, research and questionnaire-powered products',()=>{
 for(const input of[
 {title:'Research Survey Dashboard'},
 {title:'Research Papers Search'},
 {title:'Research Notes Manager'},
 {title:'Formbricks',description:'Open-source experience management platform for surveys, in-app feedback and customer insights'},
 {title:'JabRef',description:'A reference manager for scholarly literature and research'},
 {title:'Researchly',description:'Find research opportunities matched to you through a guided interview'},
 {title:'당신의영양제',description:'논문 근거로 영양제를 추천하고 복용 알람',textSample:'1분 설문 시작하기. 맞춤 추천, 최저가, 약 검색'},
 {title:'My Research Notebook',description:'A reusable research notebook app for teams to create and manage notebooks'},
 {title:'Survey Builder',description:'Create research surveys. Participant consent and anonymous responses are supported'},
 ])expect(nonProductPurpose(input)).toBeNull();
});
