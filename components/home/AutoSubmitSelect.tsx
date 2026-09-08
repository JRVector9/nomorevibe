"use client";

/** 셀렉트를 바꾸는 즉시 GET 폼을 보낸다. 제출 버튼은 스크립트 없는 브라우저용이다. */
export function AutoSubmitSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      onChange={(event) => {
        props.onChange?.(event);
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}
